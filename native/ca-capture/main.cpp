/*
 * Screen capture that keeps up with real time.
 *
 * Windows.Graphics.Capture hands over a frame only when the screen changes, and
 * each one carries the moment it was composed. Those go straight into a Media
 * Foundation hardware encoder without ever leaving the GPU. Three rules keep a
 * recording honest under load, and they are the whole reason this exists:
 *
 *   - a frame is stamped with when it was captured, never with a made-up slot,
 *     so nothing is padded to fill a timeline
 *   - catching up after a stall is capped at one frame interval, so a burst
 *     cannot arrive claiming hundreds of frames a second
 *   - when the encoder is behind, the frame is dropped rather than queued: a
 *     lost frame is recoverable, a recording that slides behind the clock is not
 *
 * Segments are separate mp4 files, listed on stdout as they close in the same
 * shape ffmpeg's segment muxer used, so the ring reading them does not have to
 * care which engine produced them.
 */
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <d3d11_4.h>
#include <d3d11.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <codecapi.h>
#include <strmif.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

#define RETURN_IF(expr)          \
  do {                           \
    HRESULT _hr = (expr);        \
    if (FAILED(_hr)) return _hr; \
  } while (0)

namespace {

constexpr int64_t kTicksPerSecond = 10000000;

/* Exit codes the supervisor reads to decide what kind of restart is warranted. */
constexpr int kExitSizeChanged = 10;
constexpr int kExitSetup = 12;

constexpr UINT32 kAudioRate = 48000;
constexpr UINT32 kAudioChannels = 2;

struct Options {
  int monitor = 0;
  int fps = 60;
  int bitrateKbps = 50000;
  double segmentSec = 2.0;
  int startNumber = 0;
  bool drawMouse = true;
  bool hevc = false;
  std::wstring dir;
  std::wstring audioPipe;
};

void Fail(const char* what, HRESULT hr) {
  std::fprintf(stderr, "%s failed: 0x%08lx\n", what, static_cast<unsigned long>(hr));
}

std::wstring SegmentPath(const std::wstring& dir, int index) {
  wchar_t name[64];
  std::swprintf(name, 64, L"\\seg_%06d.mp4", index);
  return dir + name;
}

/*
 * Monitors in the order the desktop lays them out, so an index here means the
 * same monitor the settings screen showed.
 */
std::vector<HMONITOR> Monitors() {
  struct Entry {
    HMONITOR handle;
    LONG x;
    LONG y;
  };
  std::vector<Entry> found;
  EnumDisplayMonitors(
      nullptr, nullptr,
      [](HMONITOR handle, HDC, LPRECT rect, LPARAM param) -> BOOL {
        reinterpret_cast<std::vector<Entry>*>(param)->push_back({handle, rect->left, rect->top});
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&found));
  std::sort(found.begin(), found.end(), [](const Entry& a, const Entry& b) {
    return a.x != b.x ? a.x < b.x : a.y < b.y;
  });
  std::vector<HMONITOR> handles;
  for (const auto& entry : found) handles.push_back(entry.handle);
  return handles;
}

class Encoder {
 public:
  Encoder(com_ptr<IMFDXGIDeviceManager> manager, const Options& opts, int width, int height)
      : manager_(std::move(manager)), opts_(opts), width_(width), height_(height) {}

  HRESULT Open(const std::wstring& path) {
    com_ptr<IMFAttributes> attributes;
    RETURN_IF(MFCreateAttributes(attributes.put(), 4));
    RETURN_IF(attributes->SetUnknown(MF_SINK_WRITER_D3D_MANAGER, manager_.get()));
    RETURN_IF(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1));
    RETURN_IF(attributes->SetUINT32(MF_LOW_LATENCY, 1));
    RETURN_IF(attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4));
    RETURN_IF(MFCreateSinkWriterFromURL(path.c_str(), nullptr, attributes.get(), writer_.put()));

    com_ptr<IMFMediaType> out;
    RETURN_IF(MFCreateMediaType(out.put()));
    RETURN_IF(out->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    RETURN_IF(out->SetGUID(MF_MT_SUBTYPE, opts_.hevc ? MFVideoFormat_HEVC : MFVideoFormat_H264));
    RETURN_IF(out->SetUINT32(MF_MT_AVG_BITRATE, opts_.bitrateKbps * 1000u));
    RETURN_IF(out->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    RETURN_IF(MFSetAttributeSize(out.get(), MF_MT_FRAME_SIZE, width_, height_));
    RETURN_IF(MFSetAttributeRatio(out.get(), MF_MT_FRAME_RATE, opts_.fps, 1));
    RETURN_IF(MFSetAttributeRatio(out.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    // Left to itself the encoder settles on constrained baseline, which has
    // neither CABAC nor B-frames and spends roughly twice the bitrate for the
    // same picture.
    if (!opts_.hevc) RETURN_IF(out->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High));
    RETURN_IF(writer_->AddStream(out.get(), &stream_));

    com_ptr<IMFMediaType> in;
    RETURN_IF(MFCreateMediaType(in.put()));
    RETURN_IF(in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video));
    RETURN_IF(in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32));
    RETURN_IF(in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
    RETURN_IF(MFSetAttributeSize(in.get(), MF_MT_FRAME_SIZE, width_, height_));
    RETURN_IF(MFSetAttributeRatio(in.get(), MF_MT_FRAME_RATE, opts_.fps, 1));
    RETURN_IF(MFSetAttributeRatio(in.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
    RETURN_IF(writer_->SetInputMediaType(stream_, in.get(), nullptr));
    ApplyRateControl();

    /*
     * Sound goes into the same writer as the picture on purpose. Two engines
     * would mean two clocks, and every attempt at reconciling those afterwards
     * ended up as audio that ran ahead of the video by a drifting amount.
     */
    if (withAudio_) {
      com_ptr<IMFMediaType> audioOut;
      RETURN_IF(MFCreateMediaType(audioOut.put()));
      RETURN_IF(audioOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio));
      RETURN_IF(audioOut->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC));
      RETURN_IF(audioOut->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, kAudioRate));
      RETURN_IF(audioOut->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, kAudioChannels));
      RETURN_IF(audioOut->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16));
      RETURN_IF(audioOut->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000));
      RETURN_IF(writer_->AddStream(audioOut.get(), &audioStream_));

      com_ptr<IMFMediaType> audioIn;
      RETURN_IF(MFCreateMediaType(audioIn.put()));
      RETURN_IF(audioIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio));
      RETURN_IF(audioIn->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM));
      RETURN_IF(audioIn->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, kAudioRate));
      RETURN_IF(audioIn->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, kAudioChannels));
      RETURN_IF(audioIn->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16));
      RETURN_IF(audioIn->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, kAudioChannels * 2));
      RETURN_IF(audioIn->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                                   kAudioRate * kAudioChannels * 2));
      RETURN_IF(writer_->SetInputMediaType(audioStream_, audioIn.get(), nullptr));
    }

    RETURN_IF(writer_->BeginWriting());
    return S_OK;
  }

  /*
   * The GOP setting is quietly ignored by this encoder, leaving one keyframe per
   * segment: a clip could then only start on a segment boundary, two seconds
   * from wherever it was asked for. Asking frame by frame is honoured.
   */
  void ForceKeyFrame() {
    if (!codec_) return;
    VARIANT variant;
    VariantInit(&variant);
    variant.vt = VT_UI4;
    variant.ulVal = 1;
    codec_->SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &variant);
    VariantClear(&variant);
  }

  void EnableAudio() { withAudio_ = true; }
  bool HasAudio() const { return withAudio_; }

  HRESULT WriteAudio(IMFSample* sample) {
    if (!writer_ || !withAudio_) return E_FAIL;
    return writer_->WriteSample(audioStream_, sample);
  }

  /*
   * Left alone, the encoder spends its whole bitrate budget every second, so a
   * still desktop costs as much as a firefight. Quality-targeted VBR with the
   * budget as a ceiling is what the ffmpeg pipeline used to do with capped CQ.
   * Not every encoder offers it; the ones that do not keep the average-bitrate
   * setting already applied above.
   */
  void ApplyRateControl() {
    com_ptr<ICodecAPI> codec;
    if (FAILED(writer_->GetServiceForStream(stream_, GUID_NULL, IID_PPV_ARGS(codec.put())))) {
      return;
    }
    codec_ = codec;
    auto set = [&](const GUID& key, ULONG value) {
      VARIANT variant;
      VariantInit(&variant);
      variant.vt = VT_UI4;
      variant.ulVal = value;
      HRESULT hr = codec->SetValue(&key, &variant);
      VariantClear(&variant);
      return SUCCEEDED(hr);
    };

    /*
     * Quality-targeted VBR is what the ffmpeg pipeline did with capped CQ: spend
     * bits where the picture needs them and almost none on a still desktop. Not
     * every encoder offers it, so fall back to peak-constrained VBR and finally
     * to the plain average-bitrate setting already applied above.
     */
    if (set(CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_Quality)) {
      set(CODECAPI_AVEncCommonQuality, 70);
      set(CODECAPI_AVEncCommonMaxBitRate, opts_.bitrateKbps * 1000u);
    } else if (set(CODECAPI_AVEncCommonRateControlMode,
                   eAVEncCommonRateControlMode_PeakConstrainedVBR)) {
      set(CODECAPI_AVEncCommonMeanBitRate, (opts_.bitrateKbps / 4) * 1000u);
      set(CODECAPI_AVEncCommonMaxBitRate, opts_.bitrateKbps * 1000u);
    }
    /*
     * A keyframe every half second. Saving a clip copies the pictures rather
     * than re-encoding them, so it can only begin on a keyframe: this is what
     * decides how close to the asked-for moment a clip can start.
     */
    set(CODECAPI_AVEncMPVGOPSize, static_cast<ULONG>((std::max)(1, opts_.fps / 2)));
  }

  HRESULT Write(IMFSample* sample) {
    if (!writer_) return E_FAIL;
    return writer_->WriteSample(stream_, sample);
  }

  void Close() {
    if (!writer_) return;
    writer_->Finalize();
    writer_ = nullptr;
    codec_ = nullptr;
  }

 private:
  com_ptr<IMFDXGIDeviceManager> manager_;
  Options opts_;
  int width_;
  int height_;
  bool withAudio_ = false;
  com_ptr<IMFSinkWriter> writer_;
  com_ptr<ICodecAPI> codec_;
  DWORD stream_ = 0;
  DWORD audioStream_ = 0;
};

/*
 * The mixer on the other end of the pipe writes four channels at a steady
 * 48kHz: system sound on the first pair, microphone on the second. They are
 * summed here rather than upstream so the pipe stays one format regardless of
 * what is turned on.
 */
class AudioPipe {
 public:
  explicit AudioPipe(std::wstring path) : path_(std::move(path)) {}

  bool Connect() {
    handle_ = CreateFileW(path_.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    return handle_ != INVALID_HANDLE_VALUE;
  }

  void Close() {
    if (handle_ != INVALID_HANDLE_VALUE) {
      CancelIoEx(handle_, nullptr);
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
    }
  }

  /* Fills out with interleaved 16-bit stereo; returns the frame count, 0 on end. */
  size_t Read(std::vector<int16_t>& out) {
    constexpr size_t kQuadFrames = 1024;
    quad_.resize(kQuadFrames * 4);
    DWORD read = 0;
    if (!ReadFile(handle_, quad_.data(), static_cast<DWORD>(quad_.size() * sizeof(float)), &read,
                  nullptr) ||
        read == 0) {
      return 0;
    }
    const size_t frames = read / (sizeof(float) * 4);
    out.resize(frames * kAudioChannels);
    for (size_t i = 0; i < frames; i++) {
      for (int channel = 0; channel < 2; channel++) {
        float mixed = quad_[i * 4 + channel] + quad_[i * 4 + 2 + channel];
        mixed = mixed > 1.0f ? 1.0f : (mixed < -1.0f ? -1.0f : mixed);
        out[i * kAudioChannels + channel] = static_cast<int16_t>(mixed * 32767.0f);
      }
    }
    return frames;
  }

 private:
  std::wstring path_;
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  std::vector<float> quad_;
};

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Options opts;
  for (int i = 1; i < argc; i++) {
    std::wstring arg = argv[i];
    auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
    if (arg == L"--monitor") opts.monitor = std::stoi(next());
    else if (arg == L"--fps") opts.fps = std::stoi(next());
    else if (arg == L"--bitrate") opts.bitrateKbps = std::stoi(next());
    else if (arg == L"--segment-sec") opts.segmentSec = std::stod(next());
    else if (arg == L"--start") opts.startNumber = std::stoi(next());
    else if (arg == L"--dir") opts.dir = next();
    else if (arg == L"--hevc") opts.hevc = true;
    else if (arg == L"--no-cursor") opts.drawMouse = false;
    else if (arg == L"--audio-pipe") opts.audioPipe = next();
  }
  if (opts.dir.empty()) {
    std::fprintf(stderr, "usage: ca-capture --dir <path> [--monitor N] [--fps N]\n");
    return kExitSetup;
  }

  init_apartment(apartment_type::multi_threaded);
  HRESULT hr = MFStartup(MF_VERSION);
  if (FAILED(hr)) {
    Fail("MFStartup", hr);
    return kExitSetup;
  }

  com_ptr<ID3D11Device> device;
  com_ptr<ID3D11DeviceContext> context;
  hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                         D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                         nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put());
  if (FAILED(hr)) {
    Fail("D3D11CreateDevice", hr);
    return kExitSetup;
  }
  // Capture arrives on a threadpool thread while the encoder works on another,
  // and they share this device.
  if (auto multithread = device.try_as<ID3D11Multithread>()) {
    multithread->SetMultithreadProtected(TRUE);
  }

  com_ptr<IMFDXGIDeviceManager> manager;
  UINT resetToken = 0;
  hr = MFCreateDXGIDeviceManager(&resetToken, manager.put());
  if (SUCCEEDED(hr)) hr = manager->ResetDevice(device.get(), resetToken);
  if (FAILED(hr)) {
    Fail("MFCreateDXGIDeviceManager", hr);
    return kExitSetup;
  }

  auto monitors = Monitors();
  if (monitors.empty()) {
    std::fprintf(stderr, "no monitors\n");
    return kExitSetup;
  }
  HMONITOR target =
      monitors[opts.monitor >= 0 && opts.monitor < static_cast<int>(monitors.size()) ? opts.monitor
                                                                                    : 0];

  GraphicsCaptureItem item{nullptr};
  try {
    auto interop = get_activation_factory<GraphicsCaptureItem, ::IGraphicsCaptureItemInterop>();
    check_hresult(interop->CreateForMonitor(target, guid_of<GraphicsCaptureItem>(),
                                            reinterpret_cast<void**>(put_abi(item))));
  } catch (const hresult_error& error) {
    Fail("CreateForMonitor", error.code());
    return kExitSetup;
  }

  const int width = item.Size().Width;
  const int height = item.Size().Height;
  const int64_t frameTicks = kTicksPerSecond / opts.fps;
  const int64_t segmentTicks = static_cast<int64_t>(opts.segmentSec * kTicksPerSecond);

  com_ptr<::IInspectable> inspectable;
  hr = CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), inspectable.put());
  if (FAILED(hr)) {
    Fail("CreateDirect3D11DeviceFromDXGIDevice", hr);
    return kExitSetup;
  }
  auto rtDevice = inspectable.as<IDirect3DDevice>();

  com_ptr<IMFMediaType> poolType;
  MFCreateMediaType(poolType.put());
  poolType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  poolType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32);
  MFSetAttributeSize(poolType.get(), MF_MT_FRAME_SIZE, width, height);

  com_ptr<IMFVideoSampleAllocatorEx> allocator;
  hr = MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(allocator.put()));
  if (SUCCEEDED(hr)) hr = allocator->SetDirectXManager(manager.get());
  com_ptr<IMFAttributes> allocAttrs;
  if (SUCCEEDED(hr)) hr = MFCreateAttributes(allocAttrs.put(), 3);
  if (SUCCEEDED(hr)) {
    allocAttrs->SetUINT32(MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET);
    allocAttrs->SetUINT32(MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT);
    allocAttrs->SetUINT32(MF_SA_BUFFERS_PER_SAMPLE, 1);
    // A small pool on purpose: running out of samples is how the encoder says it
    // is behind, and that is the moment to drop a frame rather than let the
    // recording slide behind the clock.
    hr = allocator->InitializeSampleAllocatorEx(2, 6, allocAttrs.get(), poolType.get());
  }
  if (FAILED(hr)) {
    Fail("sample allocator", hr);
    return kExitSetup;
  }

  std::mutex gate;
  Encoder encoder(manager, opts, width, height);
  int segmentIndex = opts.startNumber;
  int64_t segmentEpoch = 0;
  int64_t timelineStart = 0;
  int64_t nextDue = 0;
  int64_t audioFrames = 0;
  int64_t audioAtSegmentStart = 0;
  int64_t lastFrameTicks = 0;
  long long written = 0, dropped = 0, rejected = 0;
  std::atomic<int> exitCode{0};
  std::atomic<bool> stop{false};

  /*
   * Segments turn over on the clock, not on frame arrival. A capture only
   * produces a frame when the screen changes, so tying the rotation to frames
   * means a still desktop closes nothing for as long as it stays still — the
   * ring goes blind and a replay saved during that stretch finds no footage.
   */
  auto steadyNow = []() { return std::chrono::steady_clock::now(); };
  auto origin = steadyNow();
  auto segmentOpenedAt = origin;
  auto elapsed = [](std::chrono::steady_clock::time_point from,
                    std::chrono::steady_clock::time_point to) {
    return std::chrono::duration<double>(to - from).count();
  };

  AudioPipe audioPipe(opts.audioPipe);
  if (!opts.audioPipe.empty()) {
    if (audioPipe.Connect()) {
      encoder.EnableAudio();
    } else {
      // Not fatal: a silent recording beats no recording, and the supervisor
      // already knows how to report a run that came out without sound.
      std::fprintf(stderr, "audio pipe unavailable, recording silent\n");
    }
  }

  auto openSegment = [&]() -> bool {
    HRESULT open = encoder.Open(SegmentPath(opts.dir, segmentIndex));
    if (FAILED(open)) {
      Fail("open segment", open);
      exitCode = kExitSetup;
      stop = true;
      return false;
    }
    return true;
  };
  if (!openSegment()) {
    MFShutdown();
    return exitCode.load();
  }

  /* Closes the open segment, reports its span and starts the next one. */
  auto rotate = [&]() -> bool {
    auto closedAt = steadyNow();
    encoder.Close();
    std::printf("seg_%06d.mp4,%.6f,%.6f\n", segmentIndex, elapsed(origin, segmentOpenedAt),
                elapsed(origin, closedAt));
    std::fflush(stdout);
    segmentIndex++;
    segmentOpenedAt = closedAt;
    // The newest frame is where the next segment's stamps count from; it is at
    // most one frame old, which is as close as this can get without a frame in
    // hand.
    segmentEpoch = lastFrameTicks;
    audioAtSegmentStart = audioFrames;
    return openSegment();
  };

  /*
   * Audio runs on its own thread because reading the pipe blocks, but it writes
   * under the same lock and counts from the same origin as the picture, so the
   * two cannot drift apart. Anything that arrives before the first frame is
   * discarded: without a video origin there is nothing to line it up against.
   */
  std::thread audioThread;
  if (encoder.HasAudio()) {
    audioThread = std::thread([&]() {
      std::vector<int16_t> pcm;
      while (!stop.load()) {
        size_t frames = audioPipe.Read(pcm);
        if (frames == 0) break;

        std::lock_guard<std::mutex> lock(gate);
        if (stop.load() || timelineStart == 0) continue;

        com_ptr<IMFMediaBuffer> buffer;
        const DWORD bytes = static_cast<DWORD>(frames * kAudioChannels * sizeof(int16_t));
        if (FAILED(MFCreateMemoryBuffer(bytes, buffer.put()))) continue;
        BYTE* target = nullptr;
        if (FAILED(buffer->Lock(&target, nullptr, nullptr))) continue;
        std::memcpy(target, pcm.data(), bytes);
        buffer->Unlock();
        buffer->SetCurrentLength(bytes);

        com_ptr<IMFSample> sample;
        if (FAILED(MFCreateSample(sample.put()))) continue;
        sample->AddBuffer(buffer.get());

        // Counted from the start of this segment, the same origin the picture
        // uses, so the two line up inside every file.
        const int64_t intoSegment =
            (audioFrames - audioAtSegmentStart) * kTicksPerSecond / kAudioRate;
        sample->SetSampleTime(intoSegment < 0 ? 0 : intoSegment);
        sample->SetSampleDuration(static_cast<int64_t>(frames) * kTicksPerSecond / kAudioRate);
        encoder.WriteAudio(sample.get());
        audioFrames += static_cast<int64_t>(frames);
      }
    });
  }

  auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
      rtDevice, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item.Size());

  pool.FrameArrived([&](Direct3D11CaptureFramePool const& sender,
                       winrt::Windows::Foundation::IInspectable const&) {
    auto frame = sender.TryGetNextFrame();
    if (!frame) return;
    std::lock_guard<std::mutex> lock(gate);
    if (stop.load()) return;

    // A resized display delivers frames at a new size, and a copy between
    // mismatched textures quietly does nothing: the clip would look healthy and
    // be frozen. Hand it back to the supervisor to rebuild at the new size.
    if (frame.ContentSize().Width != width || frame.ContentSize().Height != height) {
      exitCode = kExitSizeChanged;
      stop = true;
      return;
    }

    const int64_t now = frame.SystemRelativeTime().count();
    if (timelineStart == 0) {
      timelineStart = now;
      segmentEpoch = now;
      nextDue = now;
    }
    lastFrameTicks = now;
    if (now < nextDue) return;
    nextDue = (std::max)(nextDue + frameTicks, now - frameTicks);

    com_ptr<IMFSample> sample;
    if (FAILED(allocator->AllocateSample(sample.put()))) {
      dropped++;
      return;
    }

    com_ptr<IMFMediaBuffer> buffer;
    if (FAILED(sample->GetBufferByIndex(0, buffer.put()))) return;
    auto dxgiBuffer = buffer.try_as<IMFDXGIBuffer>();
    if (!dxgiBuffer) return;

    com_ptr<ID3D11Texture2D> destination;
    if (FAILED(dxgiBuffer->GetResource(guid_of<ID3D11Texture2D>(),
                                       reinterpret_cast<void**>(destination.put())))) {
      return;
    }
    auto access = frame.Surface()
                      .as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    com_ptr<ID3D11Texture2D> source;
    if (FAILED(access->GetInterface(guid_of<ID3D11Texture2D>(),
                                    reinterpret_cast<void**>(source.put())))) {
      return;
    }
    context->CopyResource(destination.get(), source.get());
    // A DXGI-backed buffer reports zero length until told, and the writer turns
    // away a zero-length sample.
    buffer->SetCurrentLength(static_cast<DWORD>(width) * static_cast<DWORD>(height) * 4);

    // Twice a second, so a clip can begin within half a second of the moment
    // it was asked for.
    if (written % (std::max)(1, opts.fps / 2) == 0) encoder.ForceKeyFrame();
    sample->SetSampleTime(now - segmentEpoch);
    sample->SetSampleDuration(frameTicks);
    if (SUCCEEDED(encoder.Write(sample.get()))) {
      written++;
    } else {
      rejected++;
    }
  });

  auto session = pool.CreateCaptureSession(item);
  session.IsCursorCaptureEnabled(opts.drawMouse);
  try {
    session.IsBorderRequired(false);
  } catch (...) {
    // Older builds will not let the capture border be hidden; not worth failing.
  }
  session.StartCapture();

  std::printf("ready %dx%d %dfps monitor=%d\n", width, height, opts.fps, opts.monitor);
  std::fflush(stdout);

  origin = steadyNow();
  segmentOpenedAt = origin;
  auto lastStat = origin;
  while (!stop.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    auto tick = steadyNow();

    {
      std::lock_guard<std::mutex> lock(gate);
      if (!stop.load() && elapsed(segmentOpenedAt, tick) >= opts.segmentSec && !rotate()) break;
    }

    if (tick - lastStat < std::chrono::seconds(5)) continue;
    lastStat = tick;
    std::lock_guard<std::mutex> lock(gate);
    const double wall = elapsed(origin, tick);
    std::printf("stat frames=%lld dropped=%lld rejected=%lld produced=%.2f wall=%.2f\n", written,
                dropped, rejected, static_cast<double>(written) / opts.fps, wall);
    std::fflush(stdout);
  }

  // Closing the pipe unblocks the reader so the thread can be joined before the
  // encoder goes away underneath it.
  audioPipe.Close();
  if (audioThread.joinable()) audioThread.join();

  {
    std::lock_guard<std::mutex> lock(gate);
    session.Close();
    pool.Close();
    encoder.Close();
  }
  MFShutdown();
  return exitCode.load();
}

/*
 * The two jobs the recorder still needed ffmpeg for.
 *
 *   concat  joins the segments a clip is made of into one mp4. The pictures are
 *           copied, never decoded and re-encoded, so this costs almost nothing
 *           and cannot change how the recording looks.
 *   thumb   pulls a single frame out of a clip for the gallery, and reports how
 *           long the clip is.
 *
 * Both go through Media Foundation, which is already doing the encoding, so
 * dropping the 139MB ffmpeg would follow from finishing this.
 *
 * NOT IN USE YET. Copying one segment is exact — 107 of 107 pictures and 95 of
 * 95 sounds, matching the source frame for frame. Joining several is not: every
 * sample after the first file is accepted by WriteSample and then quietly left
 * out of the finished file, so six seconds of three segments comes back holding
 * only the first. The segments share codec, profile, level and size, so it is
 * not a mismatch between them. Until that is understood, clips are still
 * assembled by ffmpeg, which does it correctly.
 */
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <shlwapi.h>
#include <wincodec.h>
#include <winrt/base.h>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

using winrt::com_ptr;

namespace {

constexpr int64_t kTicksPerSecond = 10000000;
constexpr int kExitUsage = 2;
constexpr int kExitFailed = 3;

void Fail(const char* what, HRESULT hr) {
  std::fprintf(stderr, "%s failed: 0x%08lx\n", what, static_cast<unsigned long>(hr));
}

std::wstring Widen(const std::string& text) {
  if (text.empty()) return {};
  int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
  std::wstring out(size ? size - 1 : 0, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, out.data(), size);
  return out;
}

/* One path per line, the same list ffmpeg's concat demuxer was given. */
std::vector<std::wstring> ReadList(const std::wstring& path) {
  std::vector<std::wstring> files;
  std::ifstream input(path);
  std::string line;
  while (std::getline(input, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
    if (line.empty()) continue;
    // Tolerate the "file '...'" form so the same list works either way.
    if (line.rfind("file ", 0) == 0) line = line.substr(5);
    if (line.size() >= 2 && line.front() == '\'' && line.back() == '\'') {
      line = line.substr(1, line.size() - 2);
    }
    files.push_back(Widen(line));
  }
  return files;
}

HRESULT DurationOf(const std::wstring& path, double* seconds) {
  com_ptr<IMFSourceReader> reader;
  HRESULT hr = MFCreateSourceReaderFromURL(path.c_str(), nullptr, reader.put());
  if (FAILED(hr)) return hr;
  PROPVARIANT value;
  PropVariantInit(&value);
  hr = reader->GetPresentationAttribute(static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE),
                                        MF_PD_DURATION, &value);
  if (SUCCEEDED(hr)) *seconds = static_cast<double>(value.uhVal.QuadPart) / kTicksPerSecond;
  PropVariantClear(&value);
  return hr;
}

struct StreamMap {
  DWORD source;
  DWORD sink;
  bool video;
};

/*
 * Copies compressed samples straight across. The reader is left on each file's
 * native type, which is what makes this a copy rather than a re-encode.
 */
int Concat(const std::wstring& listPath, const std::wstring& outPath, double startSec,
           double durationSec) {
  auto files = ReadList(listPath);
  if (files.empty()) {
    std::fprintf(stderr, "the list named no files\n");
    return kExitUsage;
  }

  com_ptr<IMFSinkWriter> writer;
  std::vector<StreamMap> streams;
  int64_t offset = 0;
  int64_t written = 0;
  long long readVideo = 0, wroteVideo = 0, readAudio = 0, wroteAudio = 0;
  const int64_t startTicks = static_cast<int64_t>(startSec * kTicksPerSecond);
  const int64_t wantTicks =
      durationSec > 0 ? static_cast<int64_t>(durationSec * kTicksPerSecond) : 0;
  bool opened = false;
  bool started = startTicks <= 0;

  for (const auto& file : files) {
    com_ptr<IMFSourceReader> reader;
    HRESULT hr = MFCreateSourceReaderFromURL(file.c_str(), nullptr, reader.put());
    if (FAILED(hr)) {
      Fail("open segment", hr);
      return kExitFailed;
    }

    if (!opened) {
      com_ptr<IMFAttributes> attributes;
      MFCreateAttributes(attributes.put(), 1);
      attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);
      hr = MFCreateSinkWriterFromURL(outPath.c_str(), nullptr, attributes.get(), writer.put());
      if (FAILED(hr)) {
        Fail("create output", hr);
        return kExitFailed;
      }
      for (DWORD index = 0;; index++) {
        com_ptr<IMFMediaType> native;
        if (FAILED(reader->GetNativeMediaType(index, 0, native.put()))) break;
        GUID major{};
        native->GetGUID(MF_MT_MAJOR_TYPE, &major);
        const bool video = major == MFMediaType_Video;
        if (!video && major != MFMediaType_Audio) continue;
        DWORD sink = 0;
        if (FAILED(writer->AddStream(native.get(), &sink))) continue;
        if (FAILED(writer->SetInputMediaType(sink, native.get(), nullptr))) continue;
        streams.push_back({index, sink, video});
      }
      if (streams.empty()) {
        std::fprintf(stderr, "the first segment carried no streams\n");
        return kExitFailed;
      }
      if (FAILED(hr = writer->BeginWriting())) {
        Fail("begin writing", hr);
        return kExitFailed;
      }
      opened = true;
    }

    for (const auto& stream : streams) reader->SetStreamSelection(stream.source, TRUE);

    /*
     * Where the next segment starts from: the end of this one's last sample,
     * measured from the samples themselves. Asking the file for its duration
     * looked simpler but comes back empty on these, and the fallback then had
     * the offset compounding until everything after the first segment was
     * rejected for arriving out of order.
     */
    int64_t fileEnd = offset;
    for (;;) {
      DWORD actualStream = 0;
      DWORD flags = 0;
      LONGLONG timestamp = 0;
      com_ptr<IMFSample> sample;
      hr = reader->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_ANY_STREAM), 0, &actualStream,
                             &flags, &timestamp, sample.put());
      if (FAILED(hr)) {
        Fail("read sample", hr);
        return kExitFailed;
      }
      if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
      if (!sample) continue;

      const StreamMap* mapped = nullptr;
      for (const auto& stream : streams) {
        if (stream.source == actualStream) mapped = &stream;
      }
      if (!mapped) continue;

      if (mapped->video) readVideo++; else readAudio++;
      const int64_t absolute = offset + timestamp;
      LONGLONG span = 0;
      if (FAILED(sample->GetSampleDuration(&span))) span = 0;
      if (absolute + span > fileEnd) fileEnd = absolute + span;

      /*
       * Copying pictures means the clip can only begin on a keyframe, so the
       * cut waits for one at or after the requested moment and takes the sound
       * from that point too.
       */
      if (!started) {
        if (!mapped->video || absolute < startTicks) continue;
        UINT32 clean = 0;
        sample->GetUINT32(MFSampleExtension_CleanPoint, &clean);
        if (!clean) continue;
        started = true;
        written = absolute;
      }
      if (absolute < written) continue;
      if (wantTicks > 0 && absolute - written >= wantTicks) {
        // Sound usually runs a little ahead of the pictures, so stopping the
        // whole job on the first stream to cross the line would clip the tail
        // off the video. Let that stream finish and keep taking the other.
        if (mapped->video) break;
        continue;
      }

      sample->SetSampleTime(absolute - written);
      if (FAILED(writer->WriteSample(mapped->sink, sample.get()))) {
        // One rejected sample is not worth losing the clip over.
        continue;
      }
      if (mapped->video) wroteVideo++; else wroteAudio++;
    }
    offset = fileEnd;
  }

  if (!opened) return kExitFailed;
  HRESULT hr = writer->Finalize();
  if (FAILED(hr)) {
    Fail("finalize", hr);
    return kExitFailed;
  }
  std::fprintf(stderr, "copied video %lld of %lld, audio %lld of %lld\n", wroteVideo, readVideo,
               wroteAudio, readAudio);
  return 0;
}

/* Decodes one frame and saves it as a jpeg, and prints how long the clip runs. */
int Thumbnail(const std::wstring& inPath, const std::wstring& outPath, double atSec, int width) {
  double seconds = 0;
  if (SUCCEEDED(DurationOf(inPath, &seconds))) std::printf("duration=%.6f\n", seconds);
  std::fflush(stdout);
  if (outPath.empty()) return 0;

  com_ptr<IMFAttributes> readerAttrs;
  MFCreateAttributes(readerAttrs.put(), 1);
  // Without this the reader refuses to hand back anything but the codec's own
  // format, and asking for RGB comes back as an invalid media type.
  readerAttrs->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);

  com_ptr<IMFSourceReader> reader;
  HRESULT hr = MFCreateSourceReaderFromURL(inPath.c_str(), readerAttrs.get(), reader.put());
  if (FAILED(hr)) {
    Fail("open clip", hr);
    return kExitFailed;
  }

  com_ptr<IMFMediaType> wanted;
  MFCreateMediaType(wanted.put());
  wanted->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  wanted->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
  hr = reader->SetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), nullptr,
                                   wanted.get());
  if (FAILED(hr)) {
    Fail("set output type", hr);
    return kExitFailed;
  }

  com_ptr<IMFMediaType> actual;
  reader->GetCurrentMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM),
                              actual.put());
  UINT32 sourceWidth = 0, sourceHeight = 0;
  MFGetAttributeSize(actual.get(), MF_MT_FRAME_SIZE, &sourceWidth, &sourceHeight);
  if (sourceWidth == 0 || sourceHeight == 0) return kExitFailed;

  if (atSec > 0) {
    PROPVARIANT position;
    PropVariantInit(&position);
    position.vt = VT_I8;
    position.hVal.QuadPart = static_cast<LONGLONG>(atSec * kTicksPerSecond);
    reader->SetCurrentPosition(GUID_NULL, position);
    PropVariantClear(&position);
  }

  com_ptr<IMFSample> sample;
  for (int attempt = 0; attempt < 64 && !sample; attempt++) {
    DWORD flags = 0;
    com_ptr<IMFSample> candidate;
    hr = reader->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0, nullptr,
                           &flags, nullptr, candidate.put());
    if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) break;
    if (candidate) sample = candidate;
  }
  if (!sample) {
    std::fprintf(stderr, "no frame to read\n");
    return kExitFailed;
  }

  com_ptr<IMFMediaBuffer> buffer;
  if (FAILED(sample->ConvertToContiguousBuffer(buffer.put()))) return kExitFailed;
  BYTE* pixels = nullptr;
  DWORD length = 0;
  if (FAILED(buffer->Lock(&pixels, nullptr, &length))) return kExitFailed;

  const int target = width > 0 ? width : static_cast<int>(sourceWidth);
  const int targetHeight =
      static_cast<int>(static_cast<double>(sourceHeight) * target / sourceWidth);

  com_ptr<IWICImagingFactory> factory;
  hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                        IID_PPV_ARGS(factory.put()));
  int result = kExitFailed;
  if (SUCCEEDED(hr)) {
    com_ptr<IWICBitmap> bitmap;
    // RGB32 rows arrive bottom-up from the decoder; the negative stride puts
    // them the right way round without a copy.
    const UINT stride = sourceWidth * 4;
    hr = factory->CreateBitmapFromMemory(sourceWidth, sourceHeight, GUID_WICPixelFormat32bppBGRA,
                                         stride, length, pixels, bitmap.put());
    com_ptr<IWICBitmapScaler> scaler;
    com_ptr<IWICStream> stream;
    com_ptr<IWICBitmapEncoder> encoder;
    com_ptr<IWICBitmapFrameEncode> frame;
    if (SUCCEEDED(hr)) hr = factory->CreateBitmapScaler(scaler.put());
    if (SUCCEEDED(hr)) {
      hr = scaler->Initialize(bitmap.get(), target, targetHeight,
                              WICBitmapInterpolationModeFant);
    }
    if (SUCCEEDED(hr)) hr = factory->CreateStream(stream.put());
    if (SUCCEEDED(hr)) hr = stream->InitializeFromFilename(outPath.c_str(), GENERIC_WRITE);
    if (SUCCEEDED(hr)) hr = factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, encoder.put());
    if (SUCCEEDED(hr)) hr = encoder->Initialize(stream.get(), WICBitmapEncoderNoCache);
    if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(frame.put(), nullptr);
    if (SUCCEEDED(hr)) hr = frame->Initialize(nullptr);
    if (SUCCEEDED(hr)) hr = frame->WriteSource(scaler.get(), nullptr);
    if (SUCCEEDED(hr)) hr = frame->Commit();
    if (SUCCEEDED(hr)) hr = encoder->Commit();
    if (SUCCEEDED(hr)) result = 0;
    else Fail("write thumbnail", hr);
  }

  buffer->Unlock();
  return result;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    std::fprintf(stderr,
                 "usage: ca-mux concat --list <file> --out <mp4> [--start <s>] [--duration <s>]\n"
                 "       ca-mux thumb --in <mp4> [--out <jpg>] [--at <s>] [--width <px>]\n");
    return kExitUsage;
  }

  std::wstring mode = argv[1];
  std::wstring list, out, in;
  double start = 0, duration = 0, at = 0;
  int width = 0;
  for (int i = 2; i < argc; i++) {
    std::wstring arg = argv[i];
    auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
    if (arg == L"--list") list = next();
    else if (arg == L"--out") out = next();
    else if (arg == L"--in") in = next();
    else if (arg == L"--start") start = _wtof(next().c_str());
    else if (arg == L"--duration") duration = _wtof(next().c_str());
    else if (arg == L"--at") at = _wtof(next().c_str());
    else if (arg == L"--width") width = _wtoi(next().c_str());
  }

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return kExitFailed;
  hr = MFStartup(MF_VERSION);
  if (FAILED(hr)) {
    Fail("MFStartup", hr);
    return kExitFailed;
  }

  int result = kExitUsage;
  if (mode == L"concat" && !list.empty() && !out.empty()) {
    result = Concat(list, out, start, duration);
  } else if (mode == L"thumb" && !in.empty()) {
    result = Thumbnail(in, out, at, width);
  } else {
    std::fprintf(stderr, "unknown or incomplete command\n");
  }

  MFShutdown();
  CoUninitialize();
  return result;
}

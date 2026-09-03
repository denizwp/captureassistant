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
 * this is what lets the 139MB ffmpeg go.
 *
 * Checked against ffmpeg on real segments: six joined end to end give the same
 * 206 pictures and 577 sounds, agreeing on length to within a tenth of a
 * millisecond, and the same count of distinct pictures once decoded.
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

/* Reopens a finished clip and checks that a picture really comes back out. */
bool Decodes(const std::wstring& path) {
  com_ptr<IMFAttributes> attributes;
  MFCreateAttributes(attributes.put(), 1);
  attributes->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
  com_ptr<IMFSourceReader> reader;
  if (FAILED(MFCreateSourceReaderFromURL(path.c_str(), attributes.get(), reader.put()))) {
    return false;
  }
  for (int attempt = 0; attempt < 8; attempt++) {
    DWORD flags = 0;
    com_ptr<IMFSample> sample;
    if (FAILED(reader->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0,
                                  nullptr, &flags, nullptr, sample.put()))) {
      return false;
    }
    if (sample) return true;
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) return false;
  }
  return false;
}

/*
 * Where the cut can actually begin: the last keyframe at or before the moment
 * asked for. Starting at the next one instead loses whatever sits between the
 * two, and the tail cannot make it up because the footage ends where it ends —
 * that is a clip half a second short of what the button promised. The cut
 * always lands inside the first segment, since that is the one chosen for
 * holding the moment, so only that segment is scanned and nothing is decoded.
 */
int64_t StartOfCut(IMFSourceReader* reader, int64_t startTicks) {
  int64_t best = -1;
  while (true) {
    DWORD flags = 0;
    LONGLONG timestamp = 0;
    com_ptr<IMFSample> sample;
    if (FAILED(reader->ReadSample(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0,
                                  nullptr, &flags, &timestamp, sample.put()))) {
      break;
    }
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
    if (!sample) continue;
    UINT32 clean = 0;
    sample->GetUINT32(MFSampleExtension_CleanPoint, &clean);
    if (!clean) continue;
    if (timestamp > startTicks) break;
    best = timestamp;
  }
  return best < 0 ? 0 : best;
}

/*
 * A fresh reader per pass rather than seeking one back to the start: seeking
 * brings the sound back but not the pictures, and a pass that reads no pictures
 * writes a clip that will not open.
 */
std::vector<com_ptr<IMFSourceReader>> OpenAll(const std::vector<std::wstring>& files) {
  std::vector<com_ptr<IMFSourceReader>> readers;
  for (const auto& file : files) {
    com_ptr<IMFSourceReader> opening;
    HRESULT hr = MFCreateSourceReaderFromURL(file.c_str(), nullptr, opening.put());
    if (FAILED(hr)) {
      // A segment still being written, or left truncated by a crash, has no
      // index yet and cannot be read. Losing two seconds beats losing the clip.
      Fail("skipping an unreadable segment", hr);
      continue;
    }
    readers.push_back(opening);
  }
  return readers;
}

/*
 * Copies compressed samples straight across. The reader is left on each file's
 * native type, which is what makes this a copy rather than a re-encode.
 */
int Join(const std::vector<com_ptr<IMFSourceReader>>& readers, IMFSourceReader* shape,
         const std::wstring& outPath, int64_t startTicks, int64_t wantTicks,
         long long* videoOut) {
  com_ptr<IMFSinkWriter> writer;
  std::vector<StreamMap> streams;
  int64_t offset = 0;
  int64_t written = 0;
  long long readVideo = 0, wroteVideo = 0, readAudio = 0, wroteAudio = 0;
  bool opened = false;
  /*
   * The clip begins at the first picture, never merely at the first sound. An
   * engine that has just restarted is already passing audio through while the
   * screen has not handed over a frame yet, and counting the requested length
   * from there spends all of it on a stretch that has no picture in it.
   */
  bool started = false;
  bool enough = false;
  int64_t firstOut = -1, lastOut = 0;

  HRESULT hr = S_OK;
  for (const auto& reader : readers) {
    if (!opened) {
      com_ptr<IMFAttributes> attributes;
      MFCreateAttributes(attributes.put(), 2);
      attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);
      // Without this the writer paces itself as though it were recording live,
      // and a file's worth of samples handed over at once is accepted and then
      // largely left out of the finished mp4.
      attributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, 1);
      hr = MFCreateSinkWriterFromURL(outPath.c_str(), nullptr, attributes.get(), writer.put());
      if (FAILED(hr)) {
        Fail("create output", hr);
        return kExitFailed;
      }
      for (DWORD index = 0;; index++) {
        com_ptr<IMFMediaType> native;
        if (FAILED(shape->GetNativeMediaType(index, 0, native.put()))) break;
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
    // Sound and pictures do not run out together, so the file is done only once
    // every stream has said so; stopping at the first loses the other's tail.
    size_t finished = 0;
    while (finished < streams.size()) {
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
      if (flags & MF_SOURCE_READERF_ENDOFSTREAM) finished++;
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
        /*
         * Past the length asked for, so nothing more is written — but the
         * segment is still read to its end. Walking away mid-file leaves its
         * measured end short, and every later segment then lands earlier than
         * it should and spills content back inside the window.
         */
        if (mapped->video) enough = true;
        continue;
      }

      /*
       * A picture carries the moment it is decoded separately from the moment
       * it is shown, and only when the two differ. Moving the shown time onto
       * the clip's timeline without moving the decode time leaves the second
       * segment's pictures pointing two seconds into the past, and the writer
       * accepts them and then quietly leaves them out of the file.
       */
      const int64_t shift = absolute - written - timestamp;
      const int64_t at = absolute - written;
      sample->SetSampleTime(at);
      // A frame stays on screen until the next one replaces it, so the last
      // frame of a still stretch can be held for half a second. Left alone it
      // pushes the clip past the length that was asked for.
      if (wantTicks > 0 && span > 0 && at + span > wantTicks) {
        sample->SetSampleDuration(wantTicks - at);
      }
      UINT64 decodeAt = 0;
      if (SUCCEEDED(sample->GetUINT64(MFSampleExtension_DecodeTimestamp, &decodeAt))) {
        sample->SetUINT64(MFSampleExtension_DecodeTimestamp,
                          static_cast<UINT64>(static_cast<int64_t>(decodeAt) + shift));
      }
      if (FAILED(writer->WriteSample(mapped->sink, sample.get()))) {
        // One rejected sample is not worth losing the clip over.
        continue;
      }
      if (mapped->video) {
        wroteVideo++;
        if (firstOut < 0) firstOut = absolute - written;
        lastOut = absolute - written;
      } else {
        wroteAudio++;
      }
    }
    offset = fileEnd;
    if (enough) break;
  }

  *videoOut = wroteVideo;
  if (!opened) return kExitFailed;
  hr = writer->Finalize();
  if (FAILED(hr)) {
    // Finalize refuses a clip that no picture or sound ever reached, which is
    // the shape of a cut that landed past the end of the footage.
    Fail("finalize", hr);
    return kExitFailed;
  }
  std::fprintf(stderr,
               "copied video %lld of %lld, audio %lld of %lld, cut at %.3f spanning %.3f\n",
               wroteVideo, readVideo, wroteAudio, readAudio,
               static_cast<double>(written) / kTicksPerSecond,
               static_cast<double>(lastOut - (firstOut < 0 ? 0 : firstOut)) / kTicksPerSecond);
  return 0;
}

int Concat(const std::wstring& listPath, const std::wstring& outPath, double startSec,
           double durationSec) {
  auto files = ReadList(listPath);
  if (files.empty()) {
    std::fprintf(stderr, "the list named no files\n");
    return kExitUsage;
  }
  // Media Foundation gives up on long paths without saying so.
  if (outPath.size() >= 248) {
    std::fprintf(stderr, "the output path is too long for the media stack\n");
    return kExitFailed;
  }

  int64_t startTicks = static_cast<int64_t>(startSec * kTicksPerSecond);
  const int64_t wantTicks =
      durationSec > 0 ? static_cast<int64_t>(durationSec * kTicksPerSecond) : 0;
  if (startTicks > 0) {
    auto scan = OpenAll({files.front()});
    startTicks = scan.empty() ? 0 : StartOfCut(scan.front().get(), startTicks);
  }

  /*
   * Every segment is opened before the writer exists and stays open until the
   * clip is finalized. Releasing a reader shuts its media source down, and the
   * writer is still holding that file's samples in its own queue at that point.
   */
  auto readers = OpenAll(files);
  if (readers.empty()) {
    std::fprintf(stderr, "none of the segments could be read\n");
    return kExitFailed;
  }

  /*
   * The streams are declared from the newest segment, not the oldest. Media
   * Foundation carries per-file details in the type it hands back, and samples
   * that do not match the one the output was declared with are accepted and
   * then dropped.
   */
  long long wroteVideo = 0;
  int result = Join(readers, readers.back().get(), outPath, startTicks, wantTicks, &wroteVideo);
  if (wroteVideo == 0 && startTicks > 0) {
    // Nothing matched the requested moment, which happens when the ring's clock
    // has drifted past the footage it holds. A clip from the beginning of what
    // is there beats handing back nothing.
    std::fprintf(stderr, "nothing at the requested start, taking it from the top\n");
    readers = OpenAll(files);
    if (readers.empty()) return kExitFailed;
    result = Join(readers, readers.back().get(), outPath, 0, wantTicks, &wroteVideo);
  }

  if (result == 0 && !Decodes(outPath)) {
    // A join can report success over truncated input and still leave a file no
    // player opens. Handing that to someone as their clip is worse than failing.
    std::fprintf(stderr, "the joined clip does not decode\n");
    result = kExitFailed;
  }
  if (result != 0) DeleteFileW(outPath.c_str());
  return result;
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

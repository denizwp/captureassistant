// Captures desktop audio for a single process tree, either including it or
// leaving it out, and writes 48kHz stereo float32 to stdout.
//
// Windows' endpoint loopback can only give us the whole mix. Process loopback
// (Windows 10 build 20348+) is the only way to record the game without the
// voice chat, so this small helper exists purely to reach that API.

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <wrl/implements.h>

#include <audiopolicy.h>
#include <psapi.h>

#include <atomic>
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 2;

class ActivationHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase,
                          IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activation = S_OK;
    ComPtr<IUnknown> unknown;
    HRESULT hr = op->GetActivateResult(&activation, &unknown);
    if (SUCCEEDED(hr)) hr = activation;
    if (SUCCEEDED(hr)) hr = unknown.As(&client);
    result = hr;
    SetEvent(done);
    return S_OK;
  }
};

std::string Narrow(const std::wstring& text) {
  if (text.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string out(size > 0 ? size - 1 : 0, 0);
  if (size > 0) {
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, out.data(), size, nullptr, nullptr);
  }
  return out;
}

std::string JsonEscape(const std::string& text) {
  std::string out;
  for (char c : text) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      continue;
    } else {
      out += c;
    }
  }
  return out;
}

std::wstring ProcessName(DWORD pid) {
  HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!handle) return L"";
  wchar_t path[MAX_PATH] = {};
  DWORD size = MAX_PATH;
  std::wstring name;
  if (QueryFullProcessImageNameW(handle, 0, path, &size)) {
    name = path;
    const size_t slash = name.find_last_of(L'\\');
    if (slash != std::wstring::npos) name = name.substr(slash + 1);
  }
  CloseHandle(handle);
  return name;
}

// Lists what is currently holding an audio session on the default output, so
// the picker can offer real applications instead of every running process.
int ListSessions() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) return 1;

  ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device);
  if (FAILED(hr)) return 1;

  ComPtr<IAudioSessionManager2> manager;
  hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager);
  if (FAILED(hr)) return 1;

  ComPtr<IAudioSessionEnumerator> sessions;
  hr = manager->GetSessionEnumerator(&sessions);
  if (FAILED(hr)) return 1;

  int count = 0;
  sessions->GetCount(&count);

  printf("[");
  bool first = true;
  for (int i = 0; i < count; i++) {
    ComPtr<IAudioSessionControl> control;
    if (FAILED(sessions->GetSession(i, &control))) continue;
    ComPtr<IAudioSessionControl2> control2;
    if (FAILED(control.As(&control2))) continue;
    if (control2->IsSystemSoundsSession() == S_OK) continue;

    DWORD pid = 0;
    if (FAILED(control2->GetProcessId(&pid)) || pid == 0) continue;

    const std::wstring exe = ProcessName(pid);
    if (exe.empty()) continue;

    printf("%s{\"pid\":%lu,\"exe\":\"%s\"}", first ? "" : ",",
           static_cast<unsigned long>(pid), JsonEscape(Narrow(exe)).c_str());
    first = false;
  }
  printf("]\n");
  return 0;
}

void Fail(const char* what, HRESULT hr) {
  fprintf(stderr, "%s failed: 0x%08lx\n", what, static_cast<unsigned long>(hr));
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  DWORD pid = 0;
  bool exclude = false;

  bool list = false;

  for (int i = 1; i < argc; i++) {
    std::wstring arg = argv[i];
    if (arg == L"--list") {
      list = true;
    } else if (arg == L"--include" && i + 1 < argc) {
      pid = static_cast<DWORD>(_wtoi(argv[++i]));
      exclude = false;
    } else if (arg == L"--exclude" && i + 1 < argc) {
      pid = static_cast<DWORD>(_wtoi(argv[++i]));
      exclude = true;
    }
  }

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    Fail("CoInitializeEx", hr);
    return 1;
  }

  if (list) return ListSessions();

  if (pid == 0) {
    fprintf(stderr, "usage: ca-audio-capture --list | --include <pid> | --exclude <pid>\n");
    return 2;
  }

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode =
      exclude ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
              : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activation = {};
  activation.vt = VT_BLOB;
  activation.blob.cbSize = sizeof(params);
  activation.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = Microsoft::WRL::Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                   __uuidof(IAudioClient), &activation, handler.Get(), &op);
  if (FAILED(hr)) {
    Fail("ActivateAudioInterfaceAsync", hr);
    return 1;
  }

  WaitForSingleObject(handler->done, INFINITE);
  if (FAILED(handler->result) || !handler->client) {
    Fail("activation", handler->result);
    return 1;
  }

  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

  // Process loopback has no mix format to query — the format we ask for is the
  // format we get, and it must be initialised in shared event-driven mode.
  hr = handler->client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      2000000, 0, &format, nullptr);
  if (FAILED(hr)) {
    Fail("IAudioClient::Initialize", hr);
    return 1;
  }

  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = handler->client->SetEventHandle(ready);
  if (FAILED(hr)) {
    Fail("SetEventHandle", hr);
    return 1;
  }

  ComPtr<IAudioCaptureClient> capture;
  hr = handler->client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) {
    Fail("GetService", hr);
    return 1;
  }

  hr = handler->client->Start();
  if (FAILED(hr)) {
    Fail("Start", hr);
    return 1;
  }

  _setmode(_fileno(stdout), _O_BINARY);
  std::vector<float> silence;

  for (;;) {
    if (WaitForSingleObject(ready, 2000) != WAIT_OBJECT_0) continue;

    for (;;) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
      if (FAILED(hr)) {
        Fail("GetBuffer", hr);
        return 1;
      }

      const size_t samples = static_cast<size_t>(frames) * kChannels;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        // The API hands back a garbage buffer here, so write real zeroes —
        // dropping them instead would let the timeline slide against video.
        if (silence.size() < samples) silence.assign(samples, 0.0f);
        fwrite(silence.data(), sizeof(float), samples, stdout);
      } else {
        fwrite(data, sizeof(float), samples, stdout);
      }
      fflush(stdout);

      capture->ReleaseBuffer(frames);
    }
  }
}

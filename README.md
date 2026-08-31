<div align="center">

<img src="src/renderer/assets/logo.png" width="96" alt="Capture Assistant">

# Capture Assistant

**Oyun oynarken çalışan, geçmişe dönük ekran kaydedici.**
Bir kısayola bas, son 5 dakika klip olarak diske düşsün.

<img src="https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D4?logo=windows&logoColor=white">
<img src="https://img.shields.io/badge/Encoder-NVENC%20%7C%20AMF%20%7C%20QSV-76B900?logo=nvidia&logoColor=white">
<img src="https://img.shields.io/badge/Capture-Desktop%20Duplication-1f6feb">
<img src="https://img.shields.io/badge/Electron-34-47848F?logo=electron&logoColor=white">
<img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
<img src="https://img.shields.io/badge/Kurulum-gerekmiyor-2ea043">

</div>

---

## Ne yapıyor

Oyun oynarken arka planda sürekli kaydeder ama diske sadece senin istediğin anı
yazar. Güzel bir şey olduğunda `Alt+F10`'a basarsın, **son N dakika** klip olarak
kaydedilir. Kaçırdığın için üzülmene gerek kalmaz.

| | |
|---|---|
| 🎬 **Manuel kayıt** | `Alt+F9` ile başlat / durdur. |
| ⏪ **Geçmiş kayıt** | 1-20 dakikalık tampon, 30 saniyelik adımlarla. `Alt+F10` ile kaydet. |
| ⚡ **Oyunu kastırmaz** | Desktop Duplication'dan doğrudan GPU encoder'a. Kareler sistem belleğine hiç inmez. |
| 🔊 **Sistem sesi + mikrofon** | Karışık ses ilk kanalda; sistem ve mikrofon ayrıca kendi kanallarında. |
| 🪟 **Tepside yaşar** | Pencereyi kapat, tampon çalışmaya devam etsin. |
| 🟢 **Köşe rozetleri** | Kayıt, tampon ve mikrofon durumu bir bakışta. |

Tampon ve manuel kayıt **aynı encoder'ı paylaşır** — yani tampon açıkken kayıt
almak ekstra hiçbir maliyet getirmez.

---

## Kurulum

1. [**Releases**](https://github.com/denizwp/captureassistant/releases) sayfasından zip'i indir
2. İstediğin klasöre çıkar
3. `Capture Assistant.exe`

Installer yok. Kayıt defterine dokunmaz, Program Files'a yazmaz, yönetici yetkisi
istemez. Silmek istersen klasörü sil.

> FFmpeg paketin içinde geliyor. İndirme boyutu bu yüzden büyük, karşılığında
> uygulama tamamen çevrimdışı çalışıyor.

---

## Kısayollar

| Kısayol | İşlev |
|:--|:--|
| <kbd>Alt</kbd> + <kbd>F9</kbd> | Kaydı başlat / durdur |
| <kbd>Alt</kbd> + <kbd>F10</kbd> | Geçmiş kaydı kaydet |
| <kbd>Alt</kbd> + <kbd>F8</kbd> | Tamponu aç / kapat |
| <kbd>Alt</kbd> + <kbd>M</kbd> | Mikrofonu aç / kapat |
| <kbd>Alt</kbd> + <kbd>F7</kbd> | Rozetleri göster / gizle |

Hepsi ayarlardan değiştirilebilir. Oyun tam ekrandayken de çalışırlar.

<details>
<summary><b>Kısayollar oyunda çalışmıyorsa</b></summary>

Oyun yönetici olarak çalışıp Capture Assistant çalışmıyorsa Windows tuşları
uygulamaya iletmez. Bu durumu fark ettiğinde uygulama sana söyler; çözüm
Capture Assistant'ı da yönetici olarak açmak.

Kısayollar iki ayrı yoldan dinlenir: düşük seviyeli klavye hook'u (tuşu yutmaz,
oyunun girdisine dokunmaz) ve Windows'un kendi kısayol kaydı. Biri çalışmazsa
diğeri devreye girer.

</details>

---

## Gereksinimler

| | |
|---|---|
| **İşletim sistemi** | Windows 10 sürüm 2004 veya üstü |
| **Ekran kartı** | NVENC (GTX 900+), AMF (RX 400+) veya Intel Quick Sync |
| **Disk** | 1080p60'ta 20 dakikalık tampon için ~21 GB boş alan |

Donanım encoder'ı bulunamazsa `libx264`'e düşer, ama yazılım encode 1080p60'ta
oyundan kare götürür — o durumda uygulama seni 1080p30'da sınırlar ve bunu açıkça
söyler.

Tampon boyutu ayarlar ekranında slider'ı sürüklerken canlı olarak gösterilir.
Uygulama diskin dolmasına izin vermez; eşiğin altına inince tamponu kendisi
durdurur.

---

## Bilinen sınırlar

- **Tek monitör kaydeder.** Tek pencere yakalama Windows.Graphics.Capture
  gerektiriyor, henüz yok.
- **Rozetler kayda giriyor.** Bir pencereyi Desktop Duplication'dan çıkarmak için
  `SetWindowDisplayAffinity`'nin process'in kendi içinden çağrılması gerekiyor.
  Electron'un `setContentProtection`'ı burada `WDA_MONITOR` uyguluyor ve pencereyi
  gizlemek yerine **siyah dikdörtgen** çiziyor — rozetin görünmesinden kötü. Bu
  yüzden kullanılmıyor. *Rozetleri sürekli göster* kapatılırsa rozetler sadece
  durum değiştiğinde birkaç saniye belirir.
- **HDR, SDR'a ton eşleniyor.** Passthrough yok.
- Ada öncesi kartlarda AV1 yok, Intel iGPU olmadan Quick Sync yok. Uygulama
  açılışta gerçekten çalışanı deneyerek seçer.

---

## Nasıl çalışıyor

```
ddagrab ──► NVENC ──┐
                    ├──► 2 saniyelik MPEG-TS segmentleri ──► janitor budar
loopback + mic ─────┘                                              │
                                                                   ▼
                                              kısayol ──► baş segmenti yeniden
                                                          encode + byte-concat
                                                                   │
                                                                   ▼
                                                            tam N dakikalık mp4
```

Ring, 2 saniyelik bağımsız çözülebilir segmentlerden oluşur. Klip istendiğinde
sadece **baş segment** yeniden encode edilir (istenen an keyframe'e denk
gelmediği için), gerisi bayt bayt kopyalanır. Böylece kesim başta da sonda da
tam olur ve işlem saniyeler sürer.

<details>
<summary><b>Neden bu kadar dolambaçlı</b></summary>

- `-c copy` ile `-ss` en yakın keyframe'e yapışır; "tam son 5 dakika" istiyorsan
  baştaki kısmı yeniden encode etmen gerekir.
- Segmentler `-forced-idr` olmadan bağımsız çözülemez ve ring sessizce bozulur.
- `-reset_timestamps 0` şart; aksi halde her segment PTS 0'dan başlar ve birleşim
  bozuk çıkar.
- `ddagrab` `DXGI_ERROR_ACCESS_LOST`'u ele almıyor — tam ekran geçişleri ve
  çözünürlük değişimlerinde ffmpeg ölür. Supervisor bunu normal akışın parçası
  sayar ve yeniden başlatır.

</details>

---

## Geliştirme

```sh
npm install     # ffmpeg'i de resources/ffmpeg içine indirir
npm run dev     # kaynaktan çalıştır
npm run dist    # release/Capture Assistant-<sürüm>-win-x64.zip üretir
```

Bu hattın çoğu bozulduğunda **sessizce** bozulur, o yüzden teşhis komutları var:

```sh
npx electron . --audio-test       # gerçek ses yolundan 10 saniye kaydeder
npx electron . --capture-test     # tamponu açıp bir klip kaydeder
CA_DEBUG_HOTKEYS=1 npx electron . # hook'un gördüğü her tuşu loglar
```

Her biri `%TEMP%` altına bir log dosyası yazar.

**Stack:** Electron · TypeScript (strict) · React · FFmpeg

---

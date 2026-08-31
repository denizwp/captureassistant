<div align="center">

<img src="src/renderer/assets/logo.png" width="88" alt="">

# Capture Assistant

Windows için geçmiş kayıt tamponu olan ekran kaydedici.

<img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows&logoColor=white">
<img src="https://img.shields.io/badge/NVENC%20%C2%B7%20AMF%20%C2%B7%20QSV-76B900">
<img src="https://img.shields.io/badge/Electron-34-47848F?logo=electron&logoColor=white">
<img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
<img src="https://img.shields.io/badge/lisans-MIT-2ea043">

</div>

## Ne işe yarıyor

Arka planda sürekli son birkaç dakikayı tutar, diske ise yalnızca senin
istediğinde yazar. `Alt+F10`'a bastığında **geçmiş** N dakika klip olarak
kaydedilir — kaydı önceden başlatmış olman gerekmez.

Normal kayıt için: `Alt+F9` ile başlat, tekrar basıp bitir.

Tampon ve manuel kayıt aynı encoder üzerinden çalışır. Yani tampon açıkken kayıt
almanın ek bir maliyeti olmaz.

## Kurulum

[Releases](https://github.com/denizwp/captureassistant/releases) sayfasından
`CaptureAssistant-<sürüm>.exe` dosyasını indir ve çalıştır. Hepsi bu.

Installer yok — kayıt defterine yazmaz, Program Files'a kurulmaz, yönetici yetkisi
istemez. Uygulama ilk açılışta kendini geçici bir klasöre açar, sonraki açılışlarda
onu yeniden kullanır. Kaldırmak için exe'yi silmen yeterli.

FFmpeg pakete dahil. Dosya bu yüzden ~150 MB, karşılığında hiçbir şey indirmeden
çalışıyor.

## Kısayollar

| Tuş | Aksiyon |
|:--|:--|
| <kbd>Alt</kbd>+<kbd>F9</kbd> | Kaydı başlat / durdur |
| <kbd>Alt</kbd>+<kbd>F10</kbd> | Geçmiş kaydı kaydet |
| <kbd>Alt</kbd>+<kbd>F8</kbd> | Tamponu aç / kapat |
| <kbd>Alt</kbd>+<kbd>M</kbd> | Mikrofonu aç / kapat |
| <kbd>Alt</kbd>+<kbd>Z</kbd> | Oyun içi paneli aç |
| <kbd>Alt</kbd>+<kbd>F7</kbd> | Rozetleri göster / gizle |

Ayarlardan değiştirilebilir, varsayılana döndürme düğmesi var.

Kısayollar iki ayrı yoldan dinleniyor: düşük seviyeli bir klavye hook'u ve
Windows'un kendi kısayol kaydı. Hook tuşu yutmuyor, yani oyunun girdisine
karışmıyor. Oyun yönetici olarak çalışıp uygulama çalışmıyorsa Windows tuşları
iletmeyebilir; uygulama bunu fark ettiğinde uyarıyor.

## Ayarlar

Süre 1-20 dakika arasında, 30 saniyelik adımlarla. Kalite üç ön ayar
(Düşük / Dengeli / Yüksek) ve altında FPS, bitrate ve codec'i elle ayarlayabildiğin
bir bölüm.

Ses tarafında sistem sesi ve mikrofon ayrı ayrı açılıp kapatılıyor, seviyeleri
ayrı. Klipte üç ses kanalı oluyor: karışık, yalnızca sistem, yalnızca mikrofon.
Böylece sonradan düzenlerken mikrofonu ayrı kısabiliyorsun.

Kayıt ve tampon klasörleri değiştirilebilir. Tampon boyutu slider'ı sürüklerken
canlı gösteriliyor; disk dolmaya başlarsa uygulama tamponu kendisi durduruyor.

## Gereksinimler

- Windows 10 sürüm 2004 veya üstü.
- Donanım encoder'ı olan bir ekran kartı: NVENC (GTX 900+), AMF (RX 400+) veya
  Intel Quick Sync. Uygulama açılışta hangisinin gerçekten çalıştığını deneyerek
  seçiyor.
- Tampon için disk alanı. 1080p60'ta 20 dakika en kötü durumda ~7.7 GB ring, artı
  klip hazırlanırken geçici olarak bir o kadar daha.

Donanım encoder'ı yoksa `libx264`'e düşüyor ama yazılım encode 1080p60'ta oyundan
gözle görülür kare götürüyor; o durumda uygulama 1080p30'da sınırlıyor.

## Nasıl çalışıyor

Ekran `ddagrab` ile yakalanıp doğrudan donanım encoder'ına veriliyor; kareler
sistem belleğine hiç inmiyor. Ses ayrı bir gizli sayfada toplanıp tek bir named
pipe üzerinden aynı ffmpeg'e giriyor.

Çıktı 2 saniyelik, birbirinden bağımsız çözülebilen MPEG-TS parçaları olarak
diske yazılıyor. Bir janitor eskiyenleri siliyor, yani tampon sabit boyutta
kalıyor.

Klip istendiğinde yalnızca **ilk parça** yeniden encode ediliyor — çünkü istenen
an neredeyse hiçbir zaman bir keyframe'e denk gelmiyor — gerisi bayt bayt
kopyalanıyor. Kesim başta da sonda da tam oluyor ve işlem saniyeler sürüyor.

## Geliştirme

```sh
npm install     # ffmpeg'i resources/ffmpeg içine indirir
npm run dev
npm run dist    # release/CaptureAssistant-<sürüm>.exe
```

Bu hattın büyük kısmı bozulduğunda sessizce bozuluyor, o yüzden ayrı teşhis
girişleri var:

```sh
npx electron . --audio-test       # gerçek ses yolundan 10 saniye kaydeder
npx electron . --capture-test     # tamponu açıp bir klip üretir
CA_DEBUG_HOTKEYS=1 npx electron . # hook'un gördüğü her tuşu loglar
```

Üçü de `%TEMP%` altına log yazıyor. Supervisor'ın yaşam döngüsü her zaman
`%TEMP%\ca-supervisor.log`'a düşüyor.

## Lisans

MIT — [LICENSE](LICENSE).

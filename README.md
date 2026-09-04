<div align="center">

<img src="src/renderer/assets/logo.png" width="88" alt="">

# Capture Assistant

Windows için geçmiş kayıt tamponu olan ekran kaydedici.

<img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows&logoColor=white">
<img src="https://img.shields.io/badge/Graphics%20Capture%20%C2%B7%20Media%20Foundation-76B900">
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

## Sohbet

FiveM oynuyorsan oyundaki sohbet arka planda birikir ve her sunucu için günlük bir
metin dosyasına yazılır. Satırlar sunucudaki renkleriyle görünür; rol, OOC, özel
mesaj ve sunucu bildirimleri ayrı ayrı süzülebilir, geçmişte arama yapılabilir.

Filtreler yalnızca ekranı etkiler — diskteki dosya olduğu gibi kalır. Gördüğünü
düz TXT ya da renkleri gömülü, tek parça HTML olarak dışarı alabilirsin.

Klip kaydettiğinde o aralıkta geçen konuşma da klibin yanına aynı adla yazılır,
böylece görüntü ve sohbet birlikte durur.

Varsayılan olarak kapalıdır, `Sohbet` sekmesinden açılır.

```text
Capture Assistant Sohbet
└── 2026
    └── 09 - Eylül
        └── Sohbet [Sunucu Adı] [04-Eylül-2026].txt
```

## Kurulum

[Releases](https://github.com/denizwp/captureassistant/releases) sayfasından
`CaptureAssistant.exe` dosyasını indir ve çalıştır. Hepsi bu.

Tek tıkla, soru sormadan kuruluyor: yönetici yetkisi istemiyor, Program Files'a
dokunmuyor, kendini kullanıcı klasörüne (`%LOCALAPPDATA%\Programs`) alıyor.
Kaldırmak için Windows'un uygulama listesinden kaldırman yeterli; ayarların ve
klipslerin yerinde kalır.

İndirme ~77 MB ve içinde çalışması için gereken her şey var; kurulumdan sonra
hiçbir şey indirmiyor.

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
- Donanım encoder'ı olan bir ekran kartı. Hangisinin kullanılacağına Media
  Foundation karar veriyor, yani ekran kartının kendi encoder'ı ne ise o.
- Tampon için disk alanı. 1080p60'ta bir dakika masaüstü görüntüsü ~60 MB tutuyor;
  hareketli oyun görüntüsü bunun katı olabiliyor. Kaydedilecek süre slider'ının
  altında o an gerçekten ölçülen değer yazıyor, tahmin değil.

## Nasıl çalışıyor

Yakalama, kodlama ve birleştirme Windows'un kendi arayüzleriyle yazılmış iki
küçük yardımcı programda yapılıyor; harici bir kodlayıcı yok.

Ekran Windows Graphics Capture ile yakalanıp doğrudan donanım encoder'ına
veriliyor, kareler sistem belleğine hiç inmiyor. Her kare **yakalandığı** anla
damgalanıyor: encoder geride kalırsa kare düşürülüyor, kayıt gerçek zamandan
kopmuyor. Segmentler saatle dönüyor, yani ekran hiç değişmese bile tampon
ilerlemeye devam ediyor.

Ses ayrı bir gizli sayfada toplanıp named pipe üzerinden aynı dosyaya yazılıyor,
görüntüyle aynı zaman çizgisinde.

Çıktı 2 saniyelik parçalar hâlinde diske yazılıyor ve bir janitor eskiyenleri
siliyor, yani tampon sabit boyutta kalıyor.

Klip istendiğinde hiçbir şey yeniden kodlanmıyor: kareler oldukları gibi
kopyalanıyor, kesim istenen ana en yakın keyframe'den başlıyor. Kaydedilen klip
istenen uzunlukla ölçülebilir şekilde örtüşüyor ve işlem saniyeler sürüyor.
Kopyalama bittikten sonra dosya bir kez açılıp gerçekten çözülüyor mu diye
bakılıyor — açılmayan bir klip kaydedilmiş sayılmıyor.

## Geliştirme

```sh
npm install
npm run dev
npm run dist    # release/CaptureAssistant.exe
```

Yakalama ve birleştirme yardımcıları C++ ve ayrı derleniyor. Değiştirmedikçe
gerek yok, `resources/` altındakiler repoda hazır duruyor:

```sh
native\ca-capture\build.cmd    # resources/ca-capture.exe
native\ca-mux\build.cmd        # resources/ca-mux.exe
```

Bu hattın büyük kısmı bozulduğunda sessizce bozuluyor, o yüzden ayrı teşhis
girişleri var:

```sh
npx electron . --capture-test     # tamponu açıp klip üretir, süreleri ölçer
npx electron . --chat-test        # sahte bir oyun ucuna karşı sohbet hattını sınar
npx electron . --update-test      # güncelleyiciyi kuru çalıştırır
CA_DEBUG_HOTKEYS=1 npx electron . # hook'un gördüğü her tuşu loglar
```

`--audio-test` de duruyor ama ses seviyelerini ffmpeg ile ölçüyor; çalıştırmadan
önce `npm run fetch:ffmpeg` gerekiyor. Pakete girmiyor.

Kabuğunda `ELECTRON_RUN_AS_NODE` ayarlıysa hepsi sessizce düz Node olarak açılır
ve hiçbir pencere görünmez; `env -u ELECTRON_RUN_AS_NODE ...` ile başlat.

Üçü de `%TEMP%` altına log yazıyor. Supervisor'ın yaşam döngüsü her zaman
`%TEMP%\ca-supervisor.log`'a düşüyor.

## Lisans

MIT — [LICENSE](LICENSE).

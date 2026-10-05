# Tetherloop — Lansman ve Gelir Oyun Kitabı (0 TL)

Tarih: 2026-10-05. Koşullar: tek kişi, sıfır ek harcama (ücretli araç, alan adı, reklam bütçesi, ücretli hesap yok), mevcut YouTube araçları ücretsiz trafik kanalı olarak kullanılır.

Okuma kuralı:

- Bağlantı verilen her rakam kaynaklıdır. Bağlantısı olmayan rakam yoktur.
- **(tahmin)** etiketi: bizim öngörümüz, kaynak yok. İlk veriyle değişir.
- **bilmiyorum**: notlarımızda kaynak yok. Başvurur, sonucu kaydederiz.
- Olumsuz sonuç da sonuçtur. Her red ve her sıfır `docs/RESULTS.md` dosyasına tarihli yazılır (dosya ilk ölçümle açılır).

---

## 1. Özet

### Ne inşa edildi

- **Tek tuş.** Basılı tut: komet, retikülün altındaki gezegene halat fırlatır ve sabit hızla etrafında döner. Bırak: teğetten fırlar. Dokunmatik, fare, klavye ve gamepad aynı tek aksiyondur; işaretçiyle nişan yok.
- **Sıfır-G sapan tırmanış.** 540 px genişlikte sonsuz, tohumlu (seeded) bir kozmos. Zorluk yalnızca irtifaya bağlı; üretici saf fonksiyon, her cihazda aynı gezegenler.
- **Isı / bankalama.** Basılı tutmak Isı biriktirir: 2,4 s'de yanarsın; ne kadar sıcak bırakırsan o kadar hızlı uçarsın (en fazla +%50). Tam 360° tur, bankalanmamış stil puanını BANK'a geçirir. Ölünce bankalanmamış puan gider; sonuç kartı "masada N bıraktın" der; REWIND ödüllü reklamı seni son halata, puanın cebinde geri koyar.
- **Günlük kozmos.** UTC tarihinden türeyen tohum; Bronz 300 / Gümüş 700 / Altın 1400; seri halkası; günde 3 görev.
- **Arka uçsuz düello linki.** Tohum + skor + irtifa + 1–12 karakter takma ad + yol kaydı; web'de URL hash'inde, Telegram'da `startapp` parametresinde taşınır. Sunucu, hesap, veri tabanı yok. Rakibin düştüğü irtifa çizgi olarak, yolu soluk hayalet olarak çizilir.
- **Paylaşım kartı.** 1080×1080 PNG; koşunun parlayan yörüngesi, skor, "BEAT ME" rozeti, link.
- **Portal SDK adaptörü** (`game/js/sdk.js`). Oyun hiçbir vendor SDK'sıyla doğrudan konuşmaz. Sağlayıcı `?sdk=crazygames|poki|gd|telegram|none` ile zorlanır; yoksa sırayla algılanır: Telegram (`initData` dolu veya URL'de `tgWebAppPlatform`) → CrazyGames (`*.crazygames.com` veya `window.CrazyGames`) → Poki (`window.PokiSDK` veya hostname'de "poki") → GameDistribution (`window.gdsdk`, `GD_OPTIONS` veya `?gdid=`) → `none`. Vendor betiği yalnızca seçilen sağlayıcı için yüklenir; 4 s'de gelmezse oyun reklamsız sürer, `init()` asla reddetmez. `?debug=1` ile `none` sağlayıcısında 3 s'lik sahte ödüllü reklam görünür; gerçek kullanıcıya sessizce sahte ödül verilmez.
- **Diller:** en, tr, ru, es, pt, de, fr, id, hi, ar (`game/js/i18n.js`, parite testle zorunlu).

### Depo durumu (2026-10-05)

Mevcut: `game/js/config.js` (`G.NAME`, `G.VERSION = '1.0.0'`, bütün ayarlar; ilk yüklenen betik), `storage.js`, `i18n.js`, `audio.js`, `gameaudio.js`, `sdk.js`, `sim.js`, `duel.js`, `game/privacy.html` ve `tests/` altındaki testler. Eksik: `game/index.html`, `js/main.js`, `js/render.js`, `js/ui.js`, `js/share.js`. Bilinen uyumsuzluk: `scripts/pack.sh` sürüm numarasını `game/js/main.js` içinde arar, `G.VERSION` ise `config.js` içinde; düzeltilmezse zip `game-dev-<tarih>.zip` adıyla çıkar (tek satırlık `pack.sh` düzeltmesi: `main.js` yerine `config.js`). Bu dokümandaki her lansman adımı, oyunun tamamlanmış ve bölüm 3(a) kontrol listesinin geçmiş olmasını varsayar.

### Ne kazandırır

- Kaynaklı pazar büyüklükleri (bizim payımız değil, havuzun boyu): CrazyGames [300M+ oynanma/ay, 50M+ aylık oyuncu](https://docs.crazygames.com/faq/) ([haber kaynağı](https://gamesbeat.com/crazygames-hits-35m-users-for-browser-games-and-launches-social-multiplayer-features/)); Poki [1B+ aylık oynanma, 600+ stüdyo](https://app.cinevva.com/guides/publish-game-poki); GameDistribution [4000+ portal, 350M aylık kullanıcı](https://app.cinevva.com/guides/web-game-monetization).
- **(tahmin)** Öne çıkarılmayan, cilalı tek bir hyper-casual HTML5 oyunu: ayda **0 ile birkaç yüz USD**. Dağılım ağır kuyruklu; sonucu portal öne çıkarması belirler.
- **(tahmin)** CrazyGames öne çıkarması veya Poki kabulü ile **düşük binler USD/ay**. Buna götüren üç sıfır maliyetli kaldıraç: düello linki, yörünge paylaşım kartı, ısı/bank kancasının ilk 5 saniyede okunması.
- Telegram tarafı için kaynaklı tek rakam: Stars destekli bot özellikleri geliştiriciye [ayda $100–2.000](https://omisoft.net/blog/how-to-monetize-telegram-mini-app/) (blog tahmini, denetlenmemiş; v1'de Stars yok, dolayısıyla bize v1'de uygulanmaz).
- Kesin olan: ilk ay gelir değil ölçümdür.

### Ne kazandırmaz

- Pasif gelir: v1'de yok. Trafik üretmeden portal dışı gelir sıfırdır.
- Telegram'da satış: v1'de IAP yok. Stars faturası sunucu ister; `G.sdk.purchase()` `createInvoice` kancası olmadan `{ok:false, status:'unsupported'}` döner, mağaza "yakında" gösterir.
- "Tap-to-earn" dalgası: [bitti](https://merge.rocks/blog/telegram-mini-apps-2026-monetization-guide-how-to-earn-from-telegram-mini-apps); kaynağın ifadesiyle "grinder'ların %95'i elinde hiçbir şey olmadan". Biz o modeli kurmuyoruz.
- Liderlik tablosu, hesap, analitik: tasarım gereği yok (`explicit_non_goals`). Oyun kendi içinden hiçbir şey ölçmez; bütün sayılar portal ve platform panellerinden gelir.
- itch.io geliri: bağış. **(tahmin)** aylık tek haneli USD.

---

## 2. Gelir kanalları

| Kanal | Geliştirici payı | Başvuru | Ödeme eşiği / dönemi | Beklenen süre | Bizim build'de tetikleme |
|---|---|---|---|---|---|
| **CrazyGames** | Reklam **%60**, IAP **%70** ([2026 GameMaker web jam şartlarından](https://app.cinevva.com/guides/publish-game-crazygames); CrazyGames ana dokümanlarında pay yayımlamaz). Ödüllü video + midgame interstitial SDK v3 ile; IAP davetle, Xsolla üzerinden. | Geliştirici portalından gönderim. | Aylık, Tipalti; [€100 minimum, hedef sonraki ayın 10'u](https://docs.crazygames.com/faq/). | İnceleme süresi: **bilmiyorum**. | Hostname `*.crazygames.com` veya `window.CrazyGames` → otomatik. Yerel test: `?sdk=crazygames` (SDK `environment='local'`, reklam yerine yazı gösterir). |
| **Poki** | [Poki trafiğinde **%50**, kendi trafiğinde **%100**](https://app.cinevva.com/guides/publish-game-poki). | [developers.poki.com](https://sdk.poki.com/sdk-documentation) üzerinden; küratörlü, davetle. Huni: Player Fit Test → Web Fit Test → final inceleme. | **bilmiyorum**. | **bilmiyorum**. | `window.PokiSDK` veya hostname'de "poki" → otomatik. Yerel test: `?sdk=poki` (localhost'ta `setDebug` açık). |
| **GameDistribution** | [Net gelirin **%33**'ü (reklam + IAP)](https://faq.gamedistribution.com/hc/en-us/articles/360019771179-Submitting-your-game). | [Açık kayıt](https://developer.gamedistribution.com/register/developer/). | [Aylık rapordan sonra 60 gün içinde](https://app.cinevva.com/guides/web-game-monetization). Eşik: **bilmiyorum**. | [Onay en fazla 3 hafta; ilk değerlendirme ~1 hafta](https://static.gamedistribution.com/developer/developers-guidelines.html). | `window.gdsdk`/`GD_OPTIONS` veya `?gdid=<32-hex>` → otomatik. Yayın için gameId `G.sdk.init({ gdGameId })` ile koda yazılır; yazılmazsa (`REPLACE_WITH_GD_GAME_ID`) betik hiç yüklenmez, oyun reklamsız çalışır. |
| **Y8** | **bilmiyorum**. Para kazanma: [Y8 yönetimli reklam veya uygun geliştiricilere AdSense ortaklığı](https://www.y8.com/upload). | [y8.com/upload](https://www.y8.com/upload), açık, inceleme var. | **bilmiyorum**. | **bilmiyorum**. | SDK yok → sağlayıcı `none`. Oyun içi reklam yok; web build davranışı (Support butonu görünür). |
| **itch.io** | [Varsayılan **%10** platform kesintisi (geliştirici 0–100 arası seçer); işlem ücreti ~%2,9 + $0,30](https://app.cinevva.com/guides/itch-io-launch-guide) ([ikinci kaynak](https://generalistprogrammer.com/tutorials/how-to-make-money-on-itchio-indie-game-guide)). | Açık; anında yayın. | **bilmiyorum**. | Anında. | Sağlayıcı `none`. Başlık ve sonuç ekranındaki "Support the dev" butonu `SHARE.ITCH_URL`'i açar. |
| **Google H5 Games Ads** | **bilmiyorum** (notlarda yok). | [Başvuru ile](https://developers.google.com/ad-placement/docs/signup). Şart: [onaylı AdSense hesabı ve oynanabilir H5 oyun barındıran bir site](https://support.google.com/adsense/answer/1705831). Formatlar: [interstitial + rewarded](https://adsense.google.com/start/h5-games-ads/). | **bilmiyorum**. | **bilmiyorum**. | Adaptörde bu sağlayıcı yok. Onay gelirse `h5` adaptörü yazılır **(tahmin: 1 gün iş)**. |
| **Telegram Mini App** | Stars [dijital ürünlerde tek izinli para birimi; ≈$0,013–0,016/Star; çekim TON ile](https://merge.rocks/blog/telegram-mini-apps-2026-monetization-guide-how-to-earn-from-telegram-mini-apps) ([ikinci kaynak](https://tgden.com/en/blog/telegram-stars-and-tg-payments)). **v1'de IAP yok.** | BotFather; ücretsiz; onay süreci yok. | **bilmiyorum**. | Anında. | `Telegram.WebApp.initData` dolu veya URL'de `tgWebAppPlatform` → otomatik. Yerel test: `?sdk=telegram` (`initData` boşken oyun web gibi davranır). |

Telegram'da reklam/IAP dengesi için kaynaklı tek veri: mini oyunlarda [gelirin %60–70'i ödüllü + interstitial reklamdan, %30–40'ı Stars IAP'den](https://merge.rocks/blog/telegram-mini-apps-2026-monetization-guide-how-to-earn-from-telegram-mini-apps). Bizim v1 Telegram build'imizde ikisi de yok (Telegram içinde reklam SDK'sı entegre değil, Stars sunucu ister); Telegram v1'de yalnızca dağıtım ve düello kanalıdır.

---

## 3. Adım adım lansman planı (0 TL)

### (a) GitHub Pages'ta yayın

1. GitHub → repo → Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)`.
2. Kök `index.html`, `privacy.html`, `terms.html` dokunulmaz: başka bir aracın Google OAuth doğrulama sayfaları.
3. Oyun URL'si: `https://feederparker1-droid.github.io/tma-uploader-site/game/`. Bu URL sandbox içinden doğrulanmadı; ilk iş tarayıcıda açıp doğrulamak.
4. Gizlilik sayfası aynı dizinde: `game/privacy.html`. Ayarlar ekranındaki Privacy linki `./privacy.html` (yalnızca web build'de görünür).

Kontrol listesi — hepsi geçmeden hiçbir portala gönderim yapılmaz:

- [ ] `node tests/*.mjs` yeşil.
- [ ] `game/index.html` açılıyor; konsolda `G.VERSION` `'1.0.0'`; betikler sırayla yükleniyor (`config.js` ilk, sonra storage, i18n, audio, gameaudio, sdk, sim, duel, render, ui, share, main).
- [ ] `G.CONFIG.SHARE.APP_URL` yayın URL'siyle aynı (bugün `https://feederparker1-droid.github.io/tma-uploader-site/game/`); `SHARE.ITCH_URL` ve `SHARE.TELEGRAM_APP` doldurulmuş veya bilinçli boş.
- [ ] Gizli pencere + DevTools "Offline": oyun aynen çalışıyor, boş reklam alanı yok, başlıkta "progress saves only this session" uyarısı var.
- [ ] `?debug=1`: sonuç kartında REWIND → 3 s sahte reklam → ödül veriliyor; kapatınca `skipped`, ödül yok.
- [ ] `?sdk=crazygames`: betik yükleniyor; localhost'ta `environment='local'`; konsolda `[sdk] gameplayStart/Stop`.
- [ ] `?sdk=gd&gdid=<test id>`: `GD_OPTIONS` kuruluyor. `gdid` yokken konsolda "GD gameId not configured", oyun reklamsız sürüyor.
- [ ] `?sdk=telegram`: betik yükleniyor; `initData` boşken oyun web gibi davranıyor.
- [ ] Düello linki: `#d…` ile açılış, "X fell here" çizgisi ve hayalet yol çiziliyor; payload ≤ 1500 karakter; bozuk payload sessizce yoksayılıyor.
- [ ] Dikey ve 16:9 yatay: iki düzende de HUD doğru, "kutuda telefon" görünümü yok.
- [ ] `game/` toplam boyut < 250 KB (tasarım bütçesi). Poki'nin [< 8 MB](https://sdk.poki.com/sdk-documentation) sınırı bu bütçeyle kendiliğinden geçer.
- [ ] Ses ilk dokunuşta açılıyor; reklamda 0'a iniyor; sekme gizlenince duruyor; dönüşte 0,5 s geri sayım.
- [ ] Portal build'inde "Support" ve Privacy linkleri gizli (`provider !== 'none'`), web build'inde görünür.

### (b) `scripts/pack.sh` ile zip

```
scripts/pack.sh                      # dist/game-<G.VERSION>-<yyyymmdd>.zip
scripts/pack.sh dist/tetherloop-gd.zip
```

- `index.html` arşivin kökünde (portal şartı). Betik `.DS_Store` ve `__MACOSX` dışlar.
- Sürüm adı: betik `G.VERSION`'ı `game/js/main.js`'te arar; değer `config.js`'te. Önce `pack.sh`'taki dosya adını `config.js` yap, yoksa zip `game-dev-…` olur. Portal yüklemesinde sürüm adı sorun çıkarmaz; kendi arşivin için önemli.
- Betik `game/` boyutunu basar: Poki 8 MB kontrolü.
- Bugünkü `pack.sh` platform varyantı üretmez. GameDistribution için `gdGameId` koda yazılır ve **ayrı** bir zip alınır. CrazyGames, Y8, itch.io ve Poki tek web zip'ini kullanır; sağlayıcı hostname'den algılanır.
- Yüklemeden önce zip'i aç, `index.html` kökte mi bak. Bir kez yanlış yapılan paket üç haftalık GD kuyruğunu baştan başlatır.

### (c) CrazyGames geliştirici portalı

1. Portal hesabı aç; oyunu gönder (zip veya URL; hangisinin istendiğini portal formu söyler).
2. Görseller: **portalın güncel gereksinimlerini kontrol et** — notlarımızda CrazyGames için boyut yok. Hazırda tut: 512×512 kapak (GD ile ortak), en az 3 ekran görüntüsü, 5 saniyelik GIF (`docs/STORE-LISTING.md`).
3. SDK davranışını doğrula (adaptör yapar, sen konsoldan izle): `init()` her şeyden önce; `loadingStart/Stop`; `gameplayStart` ilk bırakışta ve her devamda, `gameplayStop` ölüm/duraklama/menüde; `happytime` seyrek (adaptör 10 s'den sık göndermez); reklam sırasında duraklat + sustur; midgame reklam yalnızca doğal molada (sonuç kartında RETRY). Aralık kuralı iki yerde yazılı: `config.js` → `ADS.MIN_GAP_MS` 90 s, `EVERY_N_DEATHS` 3, `MIN_RUN_S` 15, `FIRST_AFTER_DEATHS` 3; `sdk.js` varsayılanı ise ilk 90 s'de yok ve aralık ≥ 150 s. `main.js`'in `G.sdk.init({ interstitialMinInterval })`'e hangi değeri geçtiği geçerli olur; lansmandan önce tek değere indir ve bu dokümana yaz.
4. Dış link yok: Support/itch ve Privacy linkleri bu sağlayıcıda gizli. Hesaplı oyuncunun ilerlemesi CrazyGames SDK veri deposuna aynalanır (adaptör, `caps.cloudSave`); `game/privacy.html` bunu açıklar.
5. Ödeme: aylık, Tipalti, [€100 eşiği](https://docs.crazygames.com/faq/).
6. Red gelirse: nedeni `RESULTS.md`'ye yaz, bir kez düzelt, yeniden gönder. İkinci red bu kanalı kapatır; zaman harcanmaz.

### (d) GameDistribution

1. [Kayıt](https://developer.gamedistribution.com/register/developer/) → oyun oluştur → 32 karakterlik hex gameId.
2. gameId'yi `G.sdk.init({ gdGameId: '…' })` çağrısına yaz. `config.js`'te bugün GD id alanı yok; ya `G.CONFIG.ADS.GD_GAME_ID` alanı eklenir ve `main.js` onu `init`'e geçirir, ya doğrudan `main.js`'e yazılır. Yerelde `?sdk=gd&gdid=<id>` ile dene. GD zip'ini al.
3. Görseller: [512×512 ve 512×384 küçük resim zorunlu (en az 3 boyut), ≥ 3 oynanış ekran görüntüsü, 512×512 kapak](https://static.gamedistribution.com/developer/developers-guidelines.html).
4. Şartlar: [tamamlanmış oyun, büyük hata yok, ≥ 5 dk tutma (retention), SDK entegre](https://static.gamedistribution.com/developer/developers-guidelines.html).
5. SDK: ilk açılışta pre-roll (`showAd()` bir kullanıcı tıklamasının arkasında). Ödüllü reklam için GD panelinde "rewarded" bayrağı açılır; açılmazsa `preloadAd('rewarded')` başarısız olur ve REWIND o koşuda gizlenir. Adaptör `SDK_GAME_PAUSE`, `SDK_GAME_START` ve `SDK_REWARDED_WATCH_COMPLETE` olaylarını dinler. GDPR olaylarını (`SDK_GDPR_TRACKING/TARGETING`) dinlemez: oyun çerez koymaz ve izleme yapmaz, kapatılacak bir şey yok; onay ekranı GD SDK'nın işidir.
6. Süre: [onay ≤ 3 hafta, ilk değerlendirme ~1 hafta](https://faq.gamedistribution.com/hc/en-us/articles/360019771179-Submitting-your-game). Ödeme: [aylık rapordan sonra 60 gün içinde](https://app.cinevva.com/guides/web-game-monetization), pay %33.

### (e) Y8

1. [y8.com/upload](https://www.y8.com/upload): HTML5 zip yükle (aynı web zip'i), inceleme bekle.
2. Para: [Y8 yönetimli reklam veya uygun geliştiricilere AdSense ortaklığı](https://www.y8.com/upload). Pay, eşik ve süre: **bilmiyorum**.
3. Beklenti: **(tahmin)** gelir değil keşif trafiği. Sonuç ne olursa (sıfır dahil) kaydedilir.

### (f) itch.io sayfası

1. Yeni proje → Kind of project: *HTML* → zip yükle → "This file will be played in the browser" → gömme: tam ekran veya 540×960 pencere; mobil uyumlu seçeneğini aç.
2. Fiyat: *$0 or donate* (pay-what-you-want). Platform payı [varsayılan %10; 0–100 arası seçilir](https://app.cinevva.com/guides/itch-io-launch-guide). Varsayılanı bırak.
3. Sayfa URL'sini `game/js/config.js` → `G.CONFIG.SHARE.ITCH_URL`'e yaz (bugün `''`). Web build'de başlık ve sonuç ekranındaki "Support the dev" butonu bu URL'yi açar; boşken buton gizli kalır.
4. Sayfa metni ve görseller: `docs/STORE-LISTING.md`.
5. Devlog: sürüm başına bir yazı.

### (g) Poki'ye başvuru

1. [developers.poki.com](https://sdk.poki.com/sdk-documentation) formu; link olarak GitHub Pages URL'si.
2. Şartlar: [ilk indirme < 8 MB, masaüstü + mobilde 16:9 ölçekleme, Poki SDK, gizli pencerede çalışma, dış istekler varsayılan engelli](https://app.cinevva.com/guides/publish-game-poki). Build bunların hepsini karşılar: SDK dışında ağ isteği yok, depolama zorunlu değil, yatay düzen var.
3. Huni: Player Fit Test → Web Fit Test → final inceleme. Kabul davetle.
4. Beklenti düşük. **(tahmin)** red ihtimali kabulden yüksek. Red, "kanca ilk 30 saniyede okunmadı" verisidir; metnini kaydet, 6 ay sonra CrazyGames/GD verisiyle tekrar başvur.
5. Kabulde pay: [Poki trafiğinde %50, kendi trafiğinde %100](https://app.cinevva.com/guides/publish-game-poki).

### (h) Telegram Mini App

1. BotFather → `/newbot` → ad ve kullanıcı adı → token. v1 istemcisi token kullanmaz; sakla, repoya koyma.
2. `/newapp` → botu seç → başlık, kısa açıklama, BotFather'ın istediği fotoğraf (boyutu BotFather mesajı yazar), isteğe bağlı GIF → **Web App URL** = GitHub Pages oyun URL'si → kısa ad → `https://t.me/<bot>/<app>`.
3. `game/js/config.js` → `G.CONFIG.SHARE.TELEGRAM_APP = 'botadi/appadi'` (bugün `''`). `main.js` bunu `G.sdk.init({ appUrl: G.CONFIG.SHARE.APP_URL, tgAppUrl: 'https://t.me/' + G.CONFIG.SHARE.TELEGRAM_APP })` olarak geçer. Boşsa düello linkleri `SHARE.APP_URL`'e (web) düşer.
4. Düello payload'ı `startapp` ile taşınır (izinli karakterler `[A-Za-z0-9_-]`); adaptör `initDataUnsafe.start_param` veya `tgWebAppStartParam` okur.
5. `initData` doluysa ilerleme Telegram CloudStorage'a aynalanır (cihazlar arası). Ad ve dil varsayılanı Telegram'ın verdiği `first_name`/`language_code`'dan gelir; hiçbir yere gönderilmez.
6. Stars (v1 dışı). Sunucu tarafında [`createInvoiceLink`: `currency: "XTR"`, boş `provider_token`, tam bir fiyat kalemi → fatura linki](https://core.telegram.org/bots/api); istemcide `WebApp.openInvoice(url, cb)`, `cb('paid')` → ürünü ver ([adım adım örnek](https://dev.to/haskelldev/how-to-accept-payments-in-a-telegram-mini-app-using-stars-step-by-step-guide-46je)). Yaklaşık 30 satır. Adaptörde kanca hazır: `G.sdk.init({ createInvoice: itemId => fetch(ENDPOINT + itemId).then(r => r.text()) })`. Sunucu, ücretsiz katmanı olan bir serverless sağlayıcıda koşar; **sağlayıcı seçimi araştırılacak, 0 TL şartı geçerli**.
7. Oyun için bir Telegram kanalı aç; Daily #N paylaşımı buradan yapılır.

### (i) Google H5 Games Ads

1. Şart: [onaylı AdSense hesabı ve oynanabilir H5 oyun barındıran bir site](https://support.google.com/adsense/answer/1705831); [başvuru formu](https://developers.google.com/ad-placement/docs/signup).
2. 0 TL engeli: kendi alan adımız yok. `github.io` alt alanının AdSense site onayından geçip geçmediğini **bilmiyorum**. Başvur, sonucu kaydet. Red gelirse kanal kapanır; alan adı alınmaz.
3. Onay gelirse `sdk.js`'e `h5` sağlayıcısı eklenir ([interstitial + rewarded](https://adsense.google.com/start/h5-games-ads/)); `?sdk=h5` ile test.

---

## 4. Trafik (0 TL)

- **YouTube Shorts / TikTok — ana kanal.** Oyun dikey 540×960 oynar; 9:16 ekran kaydı kırpma istemez. Klip reçetesi: 0–2 s ısı rampası (halat kızarır, kıvılcım, hızlanan klik dizisi), 2–4 s tam tur ve BANK patlaması, 4–7 s "You left 412 on the table" kartı, son kare düello linki. Açıklama: "Aynı gezegenler. Skorumu geç." + link. Mevcut YouTube araçların yüklemeyi zamanlar; ek araç yok.
- **Düello linki.** Her sonuç kartı bir meydan okumadır. Linkler web build'e (GitHub Pages) iner; Telegram'da Mini App'e. Klip açıklamasına kendi düello linkini koy: izleyen aynı kozmosta, aynı ölüm çizgisine karşı oynar.
- **Paylaşım kartı (1080×1080).** Instagram/Threads/X görseli; Shorts kapağı için kırpılır. Oyun üretir, ek araç yok.
- **Reddit r/WebGames.** Bir gönderi; alt kuralları önce okunur; oynanabilir link + 1 GIF; 24 saat yorum cevaplanır. Kaydedilen: upvote, yorum sayısı, o gün itch görüntülenmesi.
- **itch.io devlog.** Sürüm başına bir yazı.
- **Telegram kanalı.** Her gün "Daily #N — Altın 1400" + Mini App linki.

Haftalık ritim — **(tahmin)** tek kişi için sürdürülebilir yük, 2 saat/hafta:

| Gün | İş |
|---|---|
| Pzt | Daily tohum klibi (Shorts + TikTok) |
| Sal | Telegram kanalı + 1 düello klibi |
| Çar | Shorts: "bu tohumda Altın al" (`?d=YYYYMMDD` linki) |
| Per | Panel okuma (CrazyGames / GD / itch / YouTube Studio), `RESULTS.md` güncelle |
| Cum | Devlog veya Reddit (ayda bir) |
| Cmt–Paz | Kapalı veya 1 klip |

Ritim aşılırsa önce klip sayısı düşer, kod değil.

---

## 5. Ölçüm planı — ilk 30 gün

Sınır: oyun hiçbir şey ölçmez (analitik yok, `explicit_non_goals`). Bütün sayılar üçüncü taraf panellerden gelir:

- CrazyGames / GD / Poki geliştirici panelleri: oynanma, ortalama oturum, reklam gösterimi, ödüllü tamamlanma, gelir.
- itch.io paneli: görüntülenme, oynama, bağış.
- YouTube Studio / TikTok: izlenme, izlenme süresi, link tıklaması.
- GitHub Pages: trafik ölçümü yok. Shorts linklerini itch sayfasına yönlendir; itch panelinin yönlendiren (referrer) gösterdiğini doğrula; göstermiyorsa bu kanalın tıklaması ölçülemez ve öyle kaydedilir.

Her Perşembe `docs/RESULTS.md`'ye bir satır: tarih · kanal · oynanma · ort. oturum (s) · rewarded teklif/kabul · interstitial gösterim · gelir · not.

Karar kuralları — hepsi **(tahmin)**, ilk veriyle güncellenir:

| Gözlem | Karar |
|---|---|
| CrazyGames'te 14 günde < 1000 oynanma | Kapak görseli + ilk 5 saniye: ısı rampası ve POOL sayacı daha erken ve daha büyük. Yeni kapakla yeniden gönder; sayacı sıfırla. |
| Ödüllü reklam kabulü < %20 | REWIND teklif zamanlaması: 4 s halka → 6 s; "keep your +412" sayısı 1,5× büyük. Tek değişiklik, 7 gün ölçüm. |
| Ortalama oturum < 60 s | Zorluk tablosu: 0–399 m aralığında gap ve lateral %10 kısılır. Yalnızca tablo; `V_ORBIT`, `GRAVITY`, `T_BURN` dokunulmaz. |
| Ortalama oturum > 60 s, oynanma düşük | Keşif problemi, oyun problemi değil. Oyuna dokunma; trafik kanalına yüklen. |
| GD "retention ≥ 5 dk" reddi | Daily / görev / düello girişlerini sonuç kartında öne al; bir kez yeniden gönder. |
| Shorts: 10 klipte ortalama < 1000 izlenme | Format değişir: ilk kare BANK patlaması, metin kancası "masada 412 bıraktın". 10 klip daha. |
| Shorts: tek klip > 50.000 izlenme | O klibin tohumunu `?d=` ile sabitle, düello linkiyle yeniden paylaş; aynı formatta 5 klip. |
| Interstitial şikâyeti / portal uyarısı | `interstitialMinInterval` 150 s → 240 s. |
| Poki reddi | Metni kaydet; 6 ay dokunma; CrazyGames/GD verisiyle tekrar başvur. |
| Herhangi bir panelde gösterim = 0 ama oynanma > 0 | Önce adaptör: konsolda `[sdk]` logları, betik 4 s'de yüklendi mi, GD gameId doğru mu. Reklam yoksa gelir yoktur; bu, oyun değil entegrasyon hatasıdır. |

**"Değmez" kararı** — 60. günde üçü birden doğruysa: (1) tüm kanallar toplamı < $20/ay; (2) 20+ Shorts/TikTok klibi ortalama < 1000 izlenme; (3) hiçbir portalda öne çıkarma yok, Poki kabulü yok. Sonuç: oyun bakım moduna alınır (Daily çalışır, kod dokunulmaz), `RESULTS.md`'ye yazılır, sonraki projeye geçilir. Bu da bir sonuçtur: hangi kancanın okunmadığını öğrenmiş oluruz ve bir sonraki oyun bunu bilerek başlar.

---

## 6. Risk ve engeller

Portal red nedenleri ve karşılıklarımız:

| Red nedeni | Karşılığımız |
|---|---|
| "Stickman Hook klonu" | İlk 5 s'de ısı rampası (halat rengi, kıvılcım, tıslama, klik dizisi), yörünge önizleme retikülü ve POOL sayacı görünür. Mağaza metni "hold to heat, loop to bank, duel a friend"; "swing" kelimesi hiçbir metinde yok. |
| Düşük tutma (GD ≥ 5 dk şartı) | Daily, günde 3 görev, seri halkası, düello çizgisi; ölümden yeni koşuya < 1,5 s. |
| Hatalar | `node tests/*.mjs`; gizli pencere + çevrimdışı kapısı; 30 s reklam bekçisi ve "Continue" butonu. |
| Dış link (CrazyGames yasaklar) | Support/itch ve Privacy linkleri yalnızca `provider === 'none'`. |
| Reklam sıklığı | Zamanlama tek fonksiyonda (`sdk.js`): oturumun ilk 90 s'sinde yok, aralık ≥ 150 s (varsayılan; `config.js` `ADS.MIN_GAP_MS` 90 s der — bölüm 3c, lansmandan önce tekleştir), aynı anda ikinci reklam yok. Tasarım kuralı (`config.js` `ADS`): 3. ölümden önce yok, her 3 ölümde bir, koşu ≥ 15 s, yeni rekor ve düello galibiyetinde yok. |
| SDK olayları eksik | Portal başına kontrol listesi (3c, 3d); `gameplayStart/Stop` konsoldan doğrulanır. |
| 16:9'da "telefon kutusu" görünümü | Yatay düzen: dünya tüm genişliği doldurur, HUD yan panellerde, dekoratif uzak gezegenler sütun dışında. |
| Mobil performans | DPR tavanı 2, `shadowBlur` yok, önceden çizilmiş parıltı spriti, 400'lük parçacık havuzu, 20 ms'de otomatik kalite düşüşü. |
| Poki: dış istek | SDK dışında ağ isteği yok; depolama zorunlu değil; gizli pencerede aynı oyun. |

Politika:

- **Gizlilik sayfası:** `game/privacy.html` (İngilizce + kısa Türkçe). Oyun yalnızca localStorage (Telegram içinde ek olarak CloudStorage) kullanır; hesap, analitik, çerez yok. Portal SDK'ları reklam gösterir ve veriyi kendi politikalarıyla işler; sayfa bunu adıyla söyler.
- **Çocuk hedefli değil.** Yaş notu 13+; portal formlarında "children-directed: no". Metin ve görsellerde çocuk estetiği yok.
- **Kumar yok.** Dust yalnızca oyunla veya ödüllü reklamla kazanılır; loot box yok, rastgele ödül yok, gerçek parayla oyun yok. Reklam/portal politika formlarında "gambling: no".
- Lisanslı isim, karakter, referans yok (tasarım kuralı).

Operasyonel riskler:

- Tek kişi. Haftalık 2 saat aşılırsa klip sayısı düşer, kod değil.
- GitHub Pages URL'si sandbox'tan doğrulanmadı; ilk adım doğrulamak.
- GD gameId koda gömülü: yanlış id = reklamsız oyun, panelde sıfır gösterim. `?gdid=` ile yerelde doğrula.
- Vendor betiği 4 s'de yüklenmezse oyun reklamsız sürer. Panelde gösterim sıfırsa önce bunu kontrol et.
- AdSense/H5 için alan adı şartı bilinmiyor; 0 TL kuralı alan adı almayı yasaklar. Red gelirse kanal kapanır.
- `pack.sh` tek zip üretir; GD için ayrı paket adımı unutulursa GD'de reklam çıkmaz.

---

## 7. Sonraki sürüm (v1.1+)

1. **Telegram Stars IAP sunucusu.** 30 satırlık `createInvoiceLink` ucu (`XTR`); ürünler tasarımdan: Supporter Comet 250 Stars, No interstitials 200 Stars; ikisi de `supporter=true` bayrağına bağlanır, bayrak interstitial'ı kapatır. Fiyatlandırma için kaynaklı tek referans: [≈$0,013–0,016/Star](https://merge.rocks/blog/telegram-mini-apps-2026-monetization-guide-how-to-earn-from-telegram-mini-apps).
2. **CrazyGames IAP.** [Davetle, Xsolla, %70 pay](https://app.cinevva.com/guides/publish-game-crazygames); aynı supporter bayrağı.
3. **Liderlik tablosu.** Sunucu gerekir. Düello linki v1'de bunun yerini tutar; yalnızca oynanma ve düello paylaşım sayısı haklı çıkarırsa yapılır.
4. **Yeni temalar ve kuyruk görünümleri.** Salt veri; sıfır varlık dosyası kuralı korunur.
5. **Google H5 Games Ads adaptörü** (`h5`), onay gelirse.
6. **`pack.sh` platform varyantları** (`PLATFORM=gd` ile meta etiketi), GD id'yi koda gömme yerine.
7. **GD GDPR olayları** adaptörde dinlenir (bugün yok; işlevsel etkisi sıfır, uyumluluk için).

---

## Kaynaklar

Bu dokümanda kaynaklı sayılan her rakam aşağıdaki sayfalardan gelir (toplama tarihi 2026-10-05, arama snippet'leri üzerinden):

- CrazyGames: https://app.cinevva.com/guides/publish-game-crazygames · https://docs.crazygames.com/faq/ · https://gamesbeat.com/crazygames-hits-35m-users-for-browser-games-and-launches-social-multiplayer-features/
- Poki: https://app.cinevva.com/guides/publish-game-poki · https://sdk.poki.com/sdk-documentation
- GameDistribution: https://faq.gamedistribution.com/hc/en-us/articles/360019771179-Submitting-your-game · https://static.gamedistribution.com/developer/developers-guidelines.html · https://app.cinevva.com/guides/web-game-monetization · https://developer.gamedistribution.com/register/developer/
- Y8: https://www.y8.com/upload
- itch.io: https://app.cinevva.com/guides/itch-io-launch-guide · https://generalistprogrammer.com/tutorials/how-to-make-money-on-itchio-indie-game-guide
- Google H5 Games Ads: https://support.google.com/adsense/answer/1705831 · https://developers.google.com/ad-placement/docs/signup · https://adsense.google.com/start/h5-games-ads/
- Telegram Stars / Bot API: https://merge.rocks/blog/telegram-mini-apps-2026-monetization-guide-how-to-earn-from-telegram-mini-apps · https://tgden.com/en/blog/telegram-stars-and-tg-payments · https://core.telegram.org/bots/api · https://dev.to/haskelldev/how-to-accept-payments-in-a-telegram-mini-app-using-stars-step-by-step-guide-46je · https://omisoft.net/blog/how-to-monetize-telegram-mini-app/

Kaynağı olmayan her sayı bu dokümanda **(tahmin)** veya **bilmiyorum** etiketini taşır.

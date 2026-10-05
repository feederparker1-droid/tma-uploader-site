/*!
 * G.i18n — localisation for the game shell.
 *
 * Classic script (not an ES module) so the game also runs from file://.
 * Attaches to the shared `window.G` namespace; zero network, zero dependencies.
 *
 * Public API (see JSDoc on each member below):
 *   G.i18n.STRINGS            all string tables, keyed by language code ('en' is master)
 *   G.i18n.init(opts?)        pick the language (opts.lang > ?lang= > saved > SDK user > navigator)
 *   G.i18n.t(key, vars?)      translate; `{name}` placeholders are filled from `vars`
 *   G.i18n.has(key)           true when the master table knows `key`
 *   G.i18n.lang               current language code (read-only getter)
 *   G.i18n.setLang(code)      switch language, persist via G.storage, fire window 'g:lang'
 *   G.i18n.available          supported codes, in menu order
 *   G.i18n.nativeName(code)   endonym for the language picker ('Türkçe', 'Русский', …)
 *   G.i18n.isRtl              true when the current language is written right-to-left
 *   G.i18n.dir(code?)         'rtl' | 'ltr'
 *   G.i18n.detect(list?)      first supported code from a BCP-47 list (defaults to navigator)
 *   G.i18n.fmtNumber(n)       locale-grouped integer string ("1.234.567" in tr, "12,34,567" in hi)
 *   G.i18n.apply(root?)       translate every element carrying data-i18n / data-i18n-title
 */
(function () {
  'use strict';

  var G = window.G = window.G || {};

  // Shared debug flag + logger. Each module defines them defensively so load order never matters.
  G.DEBUG = G.DEBUG || /[?&]debug=1/.test((window.location && window.location.search) || '');
  G.log = G.log || function () { if (G.DEBUG) console.log.apply(console, arguments); };

  // ---------------------------------------------------------------------------
  // String tables. 'en' is the master; every other table carries exactly the
  // same keys (enforced by tests/i18n.test.mjs). Placeholders use {name}.
  // Button labels are kept short (target ≤ 14 chars, hard limit 20).
  // ---------------------------------------------------------------------------
  var STRINGS = {
    en: {
      play: 'Play',
      tapToStart: 'Tap to start',
      tapOrSpace: 'Tap or press Space',
      gameOver: 'Game Over',
      score: 'Score',
      best: 'Best',
      newBest: 'New Best!',
      continue: 'Continue',
      watchAdToContinue: 'Watch ad to continue',
      continueFree: 'Continue free',
      skipAd: 'Skip ad',
      retry: 'Retry',
      home: 'Home',
      pause: 'Pause',
      resume: 'Resume',
      settings: 'Settings',
      sound: 'Sound',
      music: 'Music',
      haptics: 'Vibration',
      language: 'Language',
      on: 'On',
      off: 'Off',
      share: 'Share',
      shareText: 'I scored {score} — can you beat me? {url}',
      copied: 'Copied!',
      linkCopied: 'Link copied',
      challengeFriend: 'Challenge a friend',
      daily: 'Daily',
      dailyChallenge: 'Daily Challenge',
      dailyDone: 'Done for today! Come back tomorrow.',
      dailyRank: "Today's rank",
      streak: 'Streak',
      missions: 'Missions',
      missionDone: 'Mission complete!',
      claim: 'Claim',
      coins: 'Coins',
      skins: 'Skins',
      themes: 'Themes',
      locked: 'Locked',
      unlocked: 'Unlocked!',
      unlockFor: 'Unlock for {cost}',
      equip: 'Equip',
      equipped: 'Equipped',
      howToPlay: 'How to play',
      loading: 'Loading…',
      adNotAvailable: 'No ad available right now',
      adLoading: 'Loading ad…',
      rewardGranted: 'Reward claimed!',
      noThanks: 'No thanks',
      close: 'Close',
      back: 'Back',
      yes: 'Yes',
      no: 'No',
      ok: 'OK',
      cancel: 'Cancel',
      comingSoon: 'Coming soon',
      support: 'Support',
      rate: 'Rate us',
      more: 'More',
      beatYourBest: 'Beat your best!',
      playAgain: 'Play again',
      newRecord: 'New record!',
      combo: 'Combo',
      perfect: 'Perfect!',
      great: 'Great!',
      good: 'Good',
      miss: 'Miss',
      level: 'Level',
      round: 'Round',
      time: 'Time',
      highscores: 'High scores',
      you: 'You',
      friend: 'Friend',
      seedLabel: 'Seed',
      version: 'Version',
      skin_ember: 'Ember',
      skin_ion: 'Ion',
      skin_petal: 'Petal',
      skin_static: 'Static',
      skin_prism: 'Prism',
      skin_sunspot: 'Sunspot',
      skin_void: 'Void',
      skin_glitch: 'Glitch',
      theme_indigo: 'Indigo',
      theme_ember: 'Ember',
      theme_mint: 'Mint',
      theme_vapor: 'Vapor',
      theme_ink: 'Ink',
      rank_dust: 'Dust',
      rank_pebble: 'Pebble',
      rank_meteor: 'Meteor',
      rank_comet: 'Comet',
      rank_star: 'Star',
      rank_nova: 'Nova',
      rank_quasar: 'Quasar',
      mission_1: 'Graze {n} planets in one run',
      mission_2: 'Bank {n} style in one run',
      mission_3: 'Reach {n} m',
      mission_4: 'Loop {n} times in one run',
      mission_5: 'Hot shot {n} times in one run',
      mission_6: 'Reach chain x{n}',
      mission_7: 'Finish {n} runs above 200 m today',
      mission_8: 'Bank in {n} different runs today',
      mission_9: 'Play the Daily',
      mission_10: 'Reach 150 m with zero grazes',
      mission_11: 'Survive {n} s in one run',
      mission_12: 'Beat your best',
      medal_bronze: 'Bronze',
      medal_silver: 'Silver',
      medal_gold: 'Gold',
      holdToPlay: 'HOLD TO PLAY',
      releaseToFly: 'RELEASE to fly',
      holdWhenGreen: 'HOLD when the ring is green',
      loopToBank: 'Hold a FULL LOOP to BANK',
      leftOnTable: 'You left {n} on the table',
      rewindKeep: 'REWIND – keep +{n}',
      doubleDust: 'Double Dust',
      trySkinAd: 'Try (ad)',
      duelVs: 'DUEL vs {name}',
      fellHere: '{name} fell here',
      linePassed: 'LINE PASSED',
      youBeat: 'You beat {name} by {n} m',
      challenge: 'Challenge',
      dailyNumber: 'Daily #{n}',
      lifetimeToGo: '{n} m to go',
      aimGuide: 'Aim guide',
      reduceMotion: 'Reduce motion',
      proMode: 'Pro mode',
      fell: 'FELL',
      burned: 'BURNED',
      crashed: 'CRASHED',
      dust: 'Dust',
      style: 'Style',
      alt: 'Alt',
      chain: 'Chain',
      views: 'Views {a}/{b}',
      resetsIn: 'Resets in {t}',
      yesterday: 'Yesterday',
      playDaily: 'Play Daily',
      shareDaily: 'Share Daily',
      bank: 'Bank',
      heat: 'Heat',
      noAdNow: 'No ad available right now',
      longPressSave: 'Long-press to save',
      shareToChat: 'Share to chat',
      copyLink: 'Copy link',
      name: 'Name',
      duelWon: 'Duel won!',
      pressToResume: 'Press to resume',
      progressSessionOnly: 'Progress saves only this session',
      cosmos: 'Cosmos {seed}',
      beatMe: 'BEAT ME',
      tapToRetry: 'Tap to retry',
      death: 'Death'
    },

    tr: {
      play: 'Oyna',
      tapToStart: 'Başlamak için dokun',
      tapOrSpace: "Dokun ya da Boşluk'a bas",
      gameOver: 'Oyun Bitti',
      score: 'Skor',
      best: 'En İyi',
      newBest: 'Yeni Rekor!',
      continue: 'Devam Et',
      watchAdToContinue: 'İzle ve devam et',
      continueFree: 'Ücretsiz devam et',
      skipAd: 'Reklamı geç',
      retry: 'Tekrar Dene',
      home: 'Ana Menü',
      pause: 'Duraklat',
      resume: 'Devam',
      settings: 'Ayarlar',
      sound: 'Ses',
      music: 'Müzik',
      haptics: 'Titreşim',
      language: 'Dil',
      on: 'Açık',
      off: 'Kapalı',
      share: 'Paylaş',
      shareText: '{score} puan yaptım, sen geçebilir misin? {url}',
      copied: 'Kopyalandı!',
      linkCopied: 'Bağlantı kopyalandı',
      challengeFriend: 'Arkadaşa meydan oku',
      daily: 'Günlük',
      dailyChallenge: 'Günlük Meydan Okuma',
      dailyDone: 'Bugünlük tamam! Yarın görüşürüz.',
      dailyRank: 'Bugünkü sıran',
      streak: 'Seri',
      missions: 'Görevler',
      missionDone: 'Görev tamamlandı!',
      claim: 'Ödülü Al',
      coins: 'Altın',
      skins: 'Kostümler',
      themes: 'Temalar',
      locked: 'Kilitli',
      unlocked: 'Kilit açıldı!',
      unlockFor: '{cost} ile kilidi aç',
      equip: 'Kullan',
      equipped: 'Kullanılıyor',
      howToPlay: 'Nasıl oynanır',
      loading: 'Yükleniyor…',
      adNotAvailable: 'Şu an reklam yok',
      adLoading: 'Reklam yükleniyor…',
      rewardGranted: 'Ödül alındı!',
      noThanks: 'Hayır, teşekkürler',
      close: 'Kapat',
      back: 'Geri',
      yes: 'Evet',
      no: 'Hayır',
      ok: 'Tamam',
      cancel: 'İptal',
      comingSoon: 'Çok yakında',
      support: 'Destek',
      rate: 'Bizi puanla',
      more: 'Daha fazla',
      beatYourBest: 'Rekorunu kır!',
      playAgain: 'Tekrar oyna',
      newRecord: 'Yeni rekor!',
      combo: 'Kombo',
      perfect: 'Mükemmel!',
      great: 'Harika!',
      good: 'İyi',
      miss: 'Kaçtı',
      level: 'Seviye',
      round: 'Tur',
      time: 'Süre',
      highscores: 'En yüksek skorlar',
      you: 'Sen',
      friend: 'Arkadaş',
      seedLabel: 'Seed',
      version: 'Sürüm',
      skin_ember: 'Kor',
      skin_ion: 'İyon',
      skin_petal: 'Yaprak',
      skin_static: 'Parazit',
      skin_prism: 'Prizma',
      skin_sunspot: 'Güneş Beneği',
      skin_void: 'Boşluk',
      skin_glitch: 'Arıza',
      theme_indigo: 'Çivit',
      theme_ember: 'Kor',
      theme_mint: 'Nane',
      theme_vapor: 'Buhar',
      theme_ink: 'Mürekkep',
      rank_dust: 'Toz',
      rank_pebble: 'Çakıl',
      rank_meteor: 'Meteor',
      rank_comet: 'Kuyruklu Yıldız',
      rank_star: 'Yıldız',
      rank_nova: 'Nova',
      rank_quasar: 'Kuasar',
      mission_1: 'Tek koşuda {n} gezegeni sıyır',
      mission_2: 'Tek koşuda {n} stil puanı bankala',
      mission_3: '{n} m yüksekliğe ulaş',
      mission_4: 'Tek koşuda {n} kez tur at',
      mission_5: 'Tek koşuda {n} sıcak atış yap',
      mission_6: 'x{n} zincire ulaş',
      mission_7: 'Bugün {n} koşuyu 200 m üstünde bitir',
      mission_8: 'Bugün {n} farklı koşuda bankala',
      mission_9: "Günlük'ü oyna",
      mission_10: "Hiç sıyırmadan 150 m'ye ulaş",
      mission_11: 'Tek koşuda {n} saniye hayatta kal',
      mission_12: 'Rekorunu kır',
      medal_bronze: 'Bronz',
      medal_silver: 'Gümüş',
      medal_gold: 'Altın',
      holdToPlay: 'OYNAMAK İÇİN BASILI TUT',
      releaseToFly: 'Uçmak için BIRAK',
      holdWhenGreen: 'Halka yeşilken BASILI TUT',
      loopToBank: 'BANKALAMAK için TAM TUR at',
      leftOnTable: '{n} puanı masada bıraktın',
      rewindKeep: 'GERİ SAR – +{n} puanı koru',
      doubleDust: 'Tozu İkiye Katla',
      trySkinAd: 'Dene (reklam)',
      duelVs: 'DÜELLO: {name}',
      fellHere: '{name} buraya düştü',
      linePassed: 'ÇİZGİ GEÇİLDİ',
      youBeat: '{name} adlı rakibini {n} m farkla geçtin',
      challenge: 'Meydan oku',
      dailyNumber: 'Günlük #{n}',
      lifetimeToGo: '{n} m kaldı',
      aimGuide: 'Nişan kılavuzu',
      reduceMotion: 'Hareketi azalt',
      proMode: 'Pro mod',
      fell: 'DÜŞTÜ',
      burned: 'YANDI',
      crashed: 'ÇARPTI',
      dust: 'Toz',
      style: 'Stil',
      alt: 'Yükseklik',
      chain: 'Zincir',
      views: 'İzlenme {a}/{b}',
      resetsIn: '{t} sonra sıfırlanır',
      yesterday: 'Dün',
      playDaily: "Günlük'ü Oyna",
      shareDaily: "Günlük'ü Paylaş",
      bank: 'Banka',
      heat: 'Isı',
      noAdNow: 'Şu an reklam yok',
      longPressSave: 'Kaydetmek için basılı tut',
      shareToChat: 'Sohbete gönder',
      copyLink: 'Bağlantıyı kopyala',
      name: 'İsim',
      duelWon: 'Düello kazanıldı!',
      pressToResume: 'Devam etmek için bas',
      progressSessionOnly: 'İlerleme yalnızca bu oturumda saklanır',
      cosmos: 'Evren {seed}',
      beatMe: 'BENİ GEÇ',
      tapToRetry: 'Tekrar için dokun',
      death: 'Ölüm'
    },

    ru: {
      play: 'Играть',
      tapToStart: 'Нажми, чтобы начать',
      tapOrSpace: 'Тапни или нажми Пробел',
      gameOver: 'Игра окончена',
      score: 'Очки',
      best: 'Рекорд',
      newBest: 'Новый рекорд!',
      continue: 'Продолжить',
      watchAdToContinue: 'Смотреть рекламу',
      continueFree: 'Продолжить бесплатно',
      skipAd: 'Пропустить',
      retry: 'Ещё раз',
      home: 'В меню',
      pause: 'Пауза',
      resume: 'Продолжить',
      settings: 'Настройки',
      sound: 'Звук',
      music: 'Музыка',
      haptics: 'Вибрация',
      language: 'Язык',
      on: 'Вкл',
      off: 'Выкл',
      share: 'Поделиться',
      shareText: 'Мой результат: {score}. Побьёшь? {url}',
      copied: 'Скопировано!',
      linkCopied: 'Ссылка скопирована',
      challengeFriend: 'Вызвать друга',
      daily: 'Ежедневный',
      dailyChallenge: 'Ежедневный вызов',
      dailyDone: 'На сегодня всё! Возвращайся завтра.',
      dailyRank: 'Место за сегодня',
      streak: 'Серия',
      missions: 'Задания',
      missionDone: 'Задание выполнено!',
      claim: 'Забрать',
      coins: 'Монеты',
      skins: 'Скины',
      themes: 'Темы',
      locked: 'Закрыто',
      unlocked: 'Открыто!',
      unlockFor: 'Открыть за {cost}',
      equip: 'Выбрать',
      equipped: 'Выбрано',
      howToPlay: 'Как играть',
      loading: 'Загрузка…',
      adNotAvailable: 'Реклама сейчас недоступна',
      adLoading: 'Загрузка рекламы…',
      rewardGranted: 'Награда получена!',
      noThanks: 'Нет, спасибо',
      close: 'Закрыть',
      back: 'Назад',
      yes: 'Да',
      no: 'Нет',
      ok: 'ОК',
      cancel: 'Отмена',
      comingSoon: 'Скоро',
      support: 'Поддержка',
      rate: 'Оценить',
      more: 'Ещё',
      beatYourBest: 'Побей свой рекорд!',
      playAgain: 'Играть ещё',
      newRecord: 'Новый рекорд!',
      combo: 'Комбо',
      perfect: 'Идеально!',
      great: 'Отлично!',
      good: 'Хорошо',
      miss: 'Мимо',
      level: 'Уровень',
      round: 'Раунд',
      time: 'Время',
      highscores: 'Таблица рекордов',
      you: 'Ты',
      friend: 'Друг',
      seedLabel: 'Сид',
      version: 'Версия',
      skin_ember: 'Уголёк',
      skin_ion: 'Ион',
      skin_petal: 'Лепесток',
      skin_static: 'Помехи',
      skin_prism: 'Призма',
      skin_sunspot: 'Солнечное пятно',
      skin_void: 'Пустота',
      skin_glitch: 'Глитч',
      theme_indigo: 'Индиго',
      theme_ember: 'Уголёк',
      theme_mint: 'Мята',
      theme_vapor: 'Пар',
      theme_ink: 'Чернила',
      rank_dust: 'Пыль',
      rank_pebble: 'Камешек',
      rank_meteor: 'Метеор',
      rank_comet: 'Комета',
      rank_star: 'Звезда',
      rank_nova: 'Новая',
      rank_quasar: 'Квазар',
      mission_1: 'Задень {n} планет за один забег',
      mission_2: 'Сохрани {n} стиля за один забег',
      mission_3: 'Доберись до {n} м',
      mission_4: 'Сделай {n} оборота за один забег',
      mission_5: '{n} горячих запусков за один забег',
      mission_6: 'Достигни цепочки x{n}',
      mission_7: 'Заверши {n} забега выше 200 м сегодня',
      mission_8: 'Сохрани очки в {n} разных забегах сегодня',
      mission_9: 'Сыграй в Ежедневный',
      mission_10: 'Доберись до 150 м без касаний',
      mission_11: 'Продержись {n} с за один забег',
      mission_12: 'Побей свой рекорд',
      medal_bronze: 'Бронза',
      medal_silver: 'Серебро',
      medal_gold: 'Золото',
      holdToPlay: 'ЗАЖМИ, ЧТОБЫ ИГРАТЬ',
      releaseToFly: 'ОТПУСТИ, чтобы лететь',
      holdWhenGreen: 'ЗАЖМИ, когда кольцо зелёное',
      loopToBank: 'Держи ПОЛНЫЙ ОБОРОТ, чтобы СОХРАНИТЬ',
      leftOnTable: 'Ты оставил {n} на столе',
      rewindKeep: 'ОТМОТАТЬ – сохранить +{n}',
      doubleDust: 'Удвоить пыль',
      trySkinAd: 'Попробовать (реклама)',
      duelVs: 'ДУЭЛЬ с {name}',
      fellHere: '{name} упал здесь',
      linePassed: 'ЛИНИЯ ПРОЙДЕНА',
      youBeat: 'Ты обошёл {name} на {n} м',
      challenge: 'Вызов',
      dailyNumber: 'День #{n}',
      lifetimeToGo: 'ещё {n} м',
      aimGuide: 'Прицел',
      reduceMotion: 'Меньше анимации',
      proMode: 'Про-режим',
      fell: 'УПАЛ',
      burned: 'СГОРЕЛ',
      crashed: 'РАЗБИЛСЯ',
      dust: 'Пыль',
      style: 'Стиль',
      alt: 'Высота',
      chain: 'Цепочка',
      views: 'Просмотры {a}/{b}',
      resetsIn: 'Сброс через {t}',
      yesterday: 'Вчера',
      playDaily: 'Играть в Ежедневный',
      shareDaily: 'Поделиться Ежедневным',
      bank: 'Банк',
      heat: 'Нагрев',
      noAdNow: 'Реклама сейчас недоступна',
      longPressSave: 'Удерживай, чтобы сохранить',
      shareToChat: 'Отправить в чат',
      copyLink: 'Копировать ссылку',
      name: 'Имя',
      duelWon: 'Дуэль выиграна!',
      pressToResume: 'Нажми, чтобы продолжить',
      progressSessionOnly: 'Прогресс сохраняется только на эту сессию',
      cosmos: 'Космос {seed}',
      beatMe: 'ОБОЙДИ МЕНЯ',
      tapToRetry: 'Нажми, чтобы повторить',
      death: 'Гибель'
    },

    es: {
      play: 'Jugar',
      tapToStart: 'Toca para empezar',
      tapOrSpace: 'Toca o pulsa Espacio',
      gameOver: 'Fin del juego',
      score: 'Puntos',
      best: 'Récord',
      newBest: '¡Nuevo récord!',
      continue: 'Continuar',
      watchAdToContinue: 'Ver anuncio y seguir',
      continueFree: 'Continuar gratis',
      skipAd: 'Saltar anuncio',
      retry: 'Reintentar',
      home: 'Inicio',
      pause: 'Pausa',
      resume: 'Reanudar',
      settings: 'Ajustes',
      sound: 'Sonido',
      music: 'Música',
      haptics: 'Vibración',
      language: 'Idioma',
      on: 'Activado',
      off: 'Desactivado',
      share: 'Compartir',
      shareText: 'Hice {score} puntos, ¿me superas? {url}',
      copied: '¡Copiado!',
      linkCopied: 'Enlace copiado',
      challengeFriend: 'Reta a un amigo',
      daily: 'Diario',
      dailyChallenge: 'Reto diario',
      dailyDone: '¡Hecho por hoy! Vuelve mañana.',
      dailyRank: 'Puesto de hoy',
      streak: 'Racha',
      missions: 'Misiones',
      missionDone: '¡Misión cumplida!',
      claim: 'Reclamar',
      coins: 'Monedas',
      skins: 'Aspectos',
      themes: 'Temas',
      locked: 'Bloqueado',
      unlocked: '¡Desbloqueado!',
      unlockFor: 'Desbloquear por {cost}',
      equip: 'Equipar',
      equipped: 'Equipado',
      howToPlay: 'Cómo jugar',
      loading: 'Cargando…',
      adNotAvailable: 'No hay anuncios ahora',
      adLoading: 'Cargando anuncio…',
      rewardGranted: '¡Recompensa obtenida!',
      noThanks: 'No, gracias',
      close: 'Cerrar',
      back: 'Atrás',
      yes: 'Sí',
      no: 'No',
      ok: 'OK',
      cancel: 'Cancelar',
      comingSoon: 'Próximamente',
      support: 'Soporte',
      rate: 'Valóranos',
      more: 'Más',
      beatYourBest: '¡Supera tu récord!',
      playAgain: 'Jugar otra vez',
      newRecord: '¡Nuevo récord!',
      combo: 'Combo',
      perfect: '¡Perfecto!',
      great: '¡Genial!',
      good: 'Bien',
      miss: 'Fallo',
      level: 'Nivel',
      round: 'Ronda',
      time: 'Tiempo',
      highscores: 'Mejores puntuaciones',
      you: 'Tú',
      friend: 'Amigo',
      seedLabel: 'Semilla',
      version: 'Versión',
      skin_ember: 'Ascua',
      skin_ion: 'Ion',
      skin_petal: 'Pétalo',
      skin_static: 'Estática',
      skin_prism: 'Prisma',
      skin_sunspot: 'Mancha solar',
      skin_void: 'Vacío',
      skin_glitch: 'Glitch',
      theme_indigo: 'Índigo',
      theme_ember: 'Ascua',
      theme_mint: 'Menta',
      theme_vapor: 'Vapor',
      theme_ink: 'Tinta',
      rank_dust: 'Polvo',
      rank_pebble: 'Guijarro',
      rank_meteor: 'Meteoro',
      rank_comet: 'Cometa',
      rank_star: 'Estrella',
      rank_nova: 'Nova',
      rank_quasar: 'Cuásar',
      mission_1: 'Roza {n} planetas en una partida',
      mission_2: 'Asegura {n} de estilo en una partida',
      mission_3: 'Llega a {n} m',
      mission_4: 'Da {n} vueltas en una partida',
      mission_5: 'Haz {n} tiros calientes en una partida',
      mission_6: 'Alcanza cadena x{n}',
      mission_7: 'Termina {n} partidas por encima de 200 m hoy',
      mission_8: 'Asegura puntos en {n} partidas distintas hoy',
      mission_9: 'Juega el Diario',
      mission_10: 'Llega a 150 m sin rozar',
      mission_11: 'Sobrevive {n} s en una partida',
      mission_12: 'Supera tu récord',
      medal_bronze: 'Bronce',
      medal_silver: 'Plata',
      medal_gold: 'Oro',
      holdToPlay: 'MANTÉN PARA JUGAR',
      releaseToFly: 'SUELTA para volar',
      holdWhenGreen: 'MANTÉN cuando el anillo esté verde',
      loopToBank: 'Mantén una VUELTA COMPLETA para ASEGURAR',
      leftOnTable: 'Dejaste {n} sobre la mesa',
      rewindKeep: 'REBOBINAR – conserva +{n}',
      doubleDust: 'Doble polvo',
      trySkinAd: 'Probar (anuncio)',
      duelVs: 'DUELO vs {name}',
      fellHere: '{name} cayó aquí',
      linePassed: 'LÍNEA SUPERADA',
      youBeat: 'Superaste a {name} por {n} m',
      challenge: 'Desafío',
      dailyNumber: 'Diario #{n}',
      lifetimeToGo: 'faltan {n} m',
      aimGuide: 'Guía de tiro',
      reduceMotion: 'Reducir movimiento',
      proMode: 'Modo pro',
      fell: 'CAÍDA',
      burned: 'QUEMADO',
      crashed: 'CHOQUE',
      dust: 'Polvo',
      style: 'Estilo',
      alt: 'Altura',
      chain: 'Cadena',
      views: 'Vistas {a}/{b}',
      resetsIn: 'Se reinicia en {t}',
      yesterday: 'Ayer',
      playDaily: 'Jugar Diario',
      shareDaily: 'Compartir Diario',
      bank: 'Banco',
      heat: 'Calor',
      noAdNow: 'No hay anuncio ahora',
      longPressSave: 'Mantén pulsado para guardar',
      shareToChat: 'Compartir al chat',
      copyLink: 'Copiar enlace',
      name: 'Nombre',
      duelWon: '¡Duelo ganado!',
      pressToResume: 'Pulsa para continuar',
      progressSessionOnly: 'El progreso solo se guarda en esta sesión',
      cosmos: 'Cosmos {seed}',
      beatMe: 'SUPÉRAME',
      tapToRetry: 'Toca para reintentar',
      death: 'Muerte'
    },

    pt: {
      play: 'Jogar',
      tapToStart: 'Toque para começar',
      tapOrSpace: 'Toque ou aperte Espaço',
      gameOver: 'Fim de jogo',
      score: 'Pontos',
      best: 'Recorde',
      newBest: 'Novo recorde!',
      continue: 'Continuar',
      watchAdToContinue: 'Ver anúncio e seguir',
      continueFree: 'Continuar grátis',
      skipAd: 'Pular anúncio',
      retry: 'Tentar de novo',
      home: 'Início',
      pause: 'Pausar',
      resume: 'Retomar',
      settings: 'Opções',
      sound: 'Som',
      music: 'Música',
      haptics: 'Vibração',
      language: 'Idioma',
      on: 'Ligado',
      off: 'Desligado',
      share: 'Compartilhar',
      shareText: 'Fiz {score} pontos, consegue me vencer? {url}',
      copied: 'Copiado!',
      linkCopied: 'Link copiado',
      challengeFriend: 'Desafie um amigo',
      daily: 'Diário',
      dailyChallenge: 'Desafio diário',
      dailyDone: 'Feito por hoje! Volte amanhã.',
      dailyRank: 'Posição de hoje',
      streak: 'Sequência',
      missions: 'Missões',
      missionDone: 'Missão concluída!',
      claim: 'Resgatar',
      coins: 'Moedas',
      skins: 'Skins',
      themes: 'Temas',
      locked: 'Bloqueado',
      unlocked: 'Desbloqueado!',
      unlockFor: 'Desbloquear por {cost}',
      equip: 'Equipar',
      equipped: 'Equipado',
      howToPlay: 'Como jogar',
      loading: 'Carregando…',
      adNotAvailable: 'Nenhum anúncio disponível agora',
      adLoading: 'Carregando anúncio…',
      rewardGranted: 'Recompensa recebida!',
      noThanks: 'Não, obrigado',
      close: 'Fechar',
      back: 'Voltar',
      yes: 'Sim',
      no: 'Não',
      ok: 'OK',
      cancel: 'Cancelar',
      comingSoon: 'Em breve',
      support: 'Suporte',
      rate: 'Avalie-nos',
      more: 'Mais',
      beatYourBest: 'Supere seu recorde!',
      playAgain: 'Jogar de novo',
      newRecord: 'Novo recorde!',
      combo: 'Combo',
      perfect: 'Perfeito!',
      great: 'Ótimo!',
      good: 'Bom',
      miss: 'Errou',
      level: 'Nível',
      round: 'Rodada',
      time: 'Tempo',
      highscores: 'Melhores pontuações',
      you: 'Você',
      friend: 'Amigo',
      seedLabel: 'Seed',
      version: 'Versão',
      skin_ember: 'Brasa',
      skin_ion: 'Íon',
      skin_petal: 'Pétala',
      skin_static: 'Estática',
      skin_prism: 'Prisma',
      skin_sunspot: 'Mancha solar',
      skin_void: 'Vazio',
      skin_glitch: 'Glitch',
      theme_indigo: 'Índigo',
      theme_ember: 'Brasa',
      theme_mint: 'Menta',
      theme_vapor: 'Vapor',
      theme_ink: 'Tinta',
      rank_dust: 'Poeira',
      rank_pebble: 'Pedrinha',
      rank_meteor: 'Meteoro',
      rank_comet: 'Cometa',
      rank_star: 'Estrela',
      rank_nova: 'Nova',
      rank_quasar: 'Quasar',
      mission_1: 'Roce {n} planetas em uma corrida',
      mission_2: 'Guarde {n} de estilo em uma corrida',
      mission_3: 'Chegue a {n} m',
      mission_4: 'Dê {n} voltas em uma corrida',
      mission_5: 'Faça {n} tiros quentes em uma corrida',
      mission_6: 'Alcance corrente x{n}',
      mission_7: 'Termine {n} corridas acima de 200 m hoje',
      mission_8: 'Guarde pontos em {n} corridas diferentes hoje',
      mission_9: 'Jogue o Diário',
      mission_10: 'Chegue a 150 m sem roçar',
      mission_11: 'Sobreviva {n} s em uma corrida',
      mission_12: 'Supere seu recorde',
      medal_bronze: 'Bronze',
      medal_silver: 'Prata',
      medal_gold: 'Ouro',
      holdToPlay: 'SEGURE PARA JOGAR',
      releaseToFly: 'SOLTE para voar',
      holdWhenGreen: 'SEGURE quando o anel estiver verde',
      loopToBank: 'Segure uma VOLTA COMPLETA para GUARDAR',
      leftOnTable: 'Você deixou {n} na mesa',
      rewindKeep: 'VOLTAR – mantenha +{n}',
      doubleDust: 'Poeira em dobro',
      trySkinAd: 'Testar (anúncio)',
      duelVs: 'DUELO vs {name}',
      fellHere: '{name} caiu aqui',
      linePassed: 'LINHA SUPERADA',
      youBeat: 'Você superou {name} por {n} m',
      challenge: 'Desafio',
      dailyNumber: 'Diário #{n}',
      lifetimeToGo: 'faltam {n} m',
      aimGuide: 'Guia de mira',
      reduceMotion: 'Reduzir movimento',
      proMode: 'Modo pro',
      fell: 'QUEDA',
      burned: 'QUEIMADO',
      crashed: 'COLISÃO',
      dust: 'Poeira',
      style: 'Estilo',
      alt: 'Altura',
      chain: 'Corrente',
      views: 'Visualizações {a}/{b}',
      resetsIn: 'Reinicia em {t}',
      yesterday: 'Ontem',
      playDaily: 'Jogar Diário',
      shareDaily: 'Compartilhar Diário',
      bank: 'Banco',
      heat: 'Calor',
      noAdNow: 'Nenhum anúncio agora',
      longPressSave: 'Segure para salvar',
      shareToChat: 'Enviar ao chat',
      copyLink: 'Copiar link',
      name: 'Nome',
      duelWon: 'Duelo vencido!',
      pressToResume: 'Toque para continuar',
      progressSessionOnly: 'O progresso só é salvo nesta sessão',
      cosmos: 'Cosmos {seed}',
      beatMe: 'ME SUPERE',
      tapToRetry: 'Toque para tentar de novo',
      death: 'Morte'
    },

    de: {
      play: 'Spielen',
      tapToStart: 'Tippen zum Starten',
      tapOrSpace: 'Tippen oder Leertaste',
      gameOver: 'Game Over',
      score: 'Punkte',
      best: 'Rekord',
      newBest: 'Neuer Rekord!',
      continue: 'Weiter',
      watchAdToContinue: 'Werbung ansehen',
      continueFree: 'Gratis weiter',
      skipAd: 'Werbung überspringen',
      retry: 'Nochmal',
      home: 'Menü',
      pause: 'Pause',
      resume: 'Fortsetzen',
      settings: 'Einstellungen',
      sound: 'Sound',
      music: 'Musik',
      haptics: 'Vibration',
      language: 'Sprache',
      on: 'An',
      off: 'Aus',
      share: 'Teilen',
      shareText: 'Ich habe {score} Punkte geholt – schaffst du mehr? {url}',
      copied: 'Kopiert!',
      linkCopied: 'Link kopiert',
      challengeFriend: 'Freund herausfordern',
      daily: 'Täglich',
      dailyChallenge: 'Tages-Challenge',
      dailyDone: 'Für heute geschafft! Bis morgen.',
      dailyRank: 'Heutiger Rang',
      streak: 'Serie',
      missions: 'Missionen',
      missionDone: 'Mission erfüllt!',
      claim: 'Abholen',
      coins: 'Münzen',
      skins: 'Skins',
      themes: 'Designs',
      locked: 'Gesperrt',
      unlocked: 'Freigeschaltet!',
      unlockFor: 'Für {cost} freischalten',
      equip: 'Ausrüsten',
      equipped: 'Ausgerüstet',
      howToPlay: 'So wird gespielt',
      loading: 'Lädt…',
      adNotAvailable: 'Gerade keine Werbung verfügbar',
      adLoading: 'Werbung lädt…',
      rewardGranted: 'Belohnung erhalten!',
      noThanks: 'Nein, danke',
      close: 'Schließen',
      back: 'Zurück',
      yes: 'Ja',
      no: 'Nein',
      ok: 'OK',
      cancel: 'Abbrechen',
      comingSoon: 'Bald verfügbar',
      support: 'Support',
      rate: 'Bewerten',
      more: 'Mehr',
      beatYourBest: 'Knack deinen Rekord!',
      playAgain: 'Nochmal spielen',
      newRecord: 'Neuer Rekord!',
      combo: 'Combo',
      perfect: 'Perfekt!',
      great: 'Super!',
      good: 'Gut',
      miss: 'Daneben',
      level: 'Level',
      round: 'Runde',
      time: 'Zeit',
      highscores: 'Bestenliste',
      you: 'Du',
      friend: 'Freund',
      seedLabel: 'Seed',
      version: 'Version',
      skin_ember: 'Glut',
      skin_ion: 'Ion',
      skin_petal: 'Blütenblatt',
      skin_static: 'Rauschen',
      skin_prism: 'Prisma',
      skin_sunspot: 'Sonnenfleck',
      skin_void: 'Leere',
      skin_glitch: 'Glitch',
      theme_indigo: 'Indigo',
      theme_ember: 'Glut',
      theme_mint: 'Minze',
      theme_vapor: 'Dunst',
      theme_ink: 'Tinte',
      rank_dust: 'Staub',
      rank_pebble: 'Kiesel',
      rank_meteor: 'Meteor',
      rank_comet: 'Komet',
      rank_star: 'Stern',
      rank_nova: 'Nova',
      rank_quasar: 'Quasar',
      mission_1: 'Streife {n} Planeten in einem Lauf',
      mission_2: 'Sichere {n} Stil in einem Lauf',
      mission_3: 'Erreiche {n} m',
      mission_4: 'Drehe {n} Runden in einem Lauf',
      mission_5: '{n} heiße Abschüsse in einem Lauf',
      mission_6: 'Erreiche Kette x{n}',
      mission_7: 'Beende heute {n} Läufe über 200 m',
      mission_8: 'Sichere heute in {n} verschiedenen Läufen',
      mission_9: 'Spiel die Tageschallenge',
      mission_10: 'Erreiche 150 m ohne Streifen',
      mission_11: 'Überlebe {n} s in einem Lauf',
      mission_12: 'Schlag deinen Rekord',
      medal_bronze: 'Bronze',
      medal_silver: 'Silber',
      medal_gold: 'Gold',
      holdToPlay: 'HALTEN ZUM SPIELEN',
      releaseToFly: 'LOSLASSEN zum Fliegen',
      holdWhenGreen: 'HALTEN, wenn der Ring grün ist',
      loopToBank: 'Eine VOLLE RUNDE halten, um zu SICHERN',
      leftOnTable: 'Du hast {n} liegen lassen',
      rewindKeep: 'ZURÜCKSPULEN – behalte +{n}',
      doubleDust: 'Doppelter Staub',
      trySkinAd: 'Testen (Werbung)',
      duelVs: 'DUELL vs {name}',
      fellHere: '{name} fiel hier',
      linePassed: 'LINIE PASSIERT',
      youBeat: 'Du hast {name} um {n} m geschlagen',
      challenge: 'Herausfordern',
      dailyNumber: 'Tag #{n}',
      lifetimeToGo: 'noch {n} m',
      aimGuide: 'Zielhilfe',
      reduceMotion: 'Weniger Bewegung',
      proMode: 'Profi-Modus',
      fell: 'GESTÜRZT',
      burned: 'VERBRANNT',
      crashed: 'ZERSCHELLT',
      dust: 'Staub',
      style: 'Stil',
      alt: 'Höhe',
      chain: 'Kette',
      views: 'Ansichten {a}/{b}',
      resetsIn: 'Reset in {t}',
      yesterday: 'Gestern',
      playDaily: 'Tageschallenge spielen',
      shareDaily: 'Tageschallenge teilen',
      bank: 'Bank',
      heat: 'Hitze',
      noAdNow: 'Gerade keine Werbung verfügbar',
      longPressSave: 'Lange drücken zum Speichern',
      shareToChat: 'In Chat teilen',
      copyLink: 'Link kopieren',
      name: 'Name',
      duelWon: 'Duell gewonnen!',
      pressToResume: 'Drücken zum Fortsetzen',
      progressSessionOnly: 'Fortschritt wird nur in dieser Sitzung gespeichert',
      cosmos: 'Kosmos {seed}',
      beatMe: 'SCHLAG MICH',
      tapToRetry: 'Tippen für neuen Versuch',
      death: 'Tod'
    },

    fr: {
      play: 'Jouer',
      tapToStart: 'Appuie pour commencer',
      tapOrSpace: 'Appuie ou touche Espace',
      gameOver: 'Partie terminée',
      score: 'Score',
      best: 'Record',
      newBest: 'Nouveau record !',
      continue: 'Continuer',
      watchAdToContinue: 'Regarder une pub',
      continueFree: 'Continuer (gratuit)',
      skipAd: 'Passer la pub',
      retry: 'Réessayer',
      home: 'Accueil',
      pause: 'Pause',
      resume: 'Reprendre',
      settings: 'Réglages',
      sound: 'Son',
      music: 'Musique',
      haptics: 'Vibrations',
      language: 'Langue',
      on: 'Activé',
      off: 'Désactivé',
      share: 'Partager',
      shareText: "J'ai fait {score} points, tu fais mieux ? {url}",
      copied: 'Copié !',
      linkCopied: 'Lien copié',
      challengeFriend: 'Défier un ami',
      daily: 'Quotidien',
      dailyChallenge: 'Défi du jour',
      dailyDone: "C'est fait pour aujourd'hui ! À demain.",
      dailyRank: 'Classement du jour',
      streak: 'Série',
      missions: 'Missions',
      missionDone: 'Mission accomplie !',
      claim: 'Récupérer',
      coins: 'Pièces',
      skins: 'Skins',
      themes: 'Thèmes',
      locked: 'Verrouillé',
      unlocked: 'Débloqué !',
      unlockFor: 'Débloquer pour {cost}',
      equip: 'Équiper',
      equipped: 'Équipé',
      howToPlay: 'Comment jouer',
      loading: 'Chargement…',
      adNotAvailable: "Aucune pub disponible pour l'instant",
      adLoading: 'Chargement de la pub…',
      rewardGranted: 'Récompense obtenue !',
      noThanks: 'Non merci',
      close: 'Fermer',
      back: 'Retour',
      yes: 'Oui',
      no: 'Non',
      ok: 'OK',
      cancel: 'Annuler',
      comingSoon: 'Bientôt disponible',
      support: 'Assistance',
      rate: 'Noter le jeu',
      more: 'Plus',
      beatYourBest: 'Bats ton record !',
      playAgain: 'Rejouer',
      newRecord: 'Nouveau record !',
      combo: 'Combo',
      perfect: 'Parfait !',
      great: 'Génial !',
      good: 'Bien',
      miss: 'Raté',
      level: 'Niveau',
      round: 'Manche',
      time: 'Temps',
      highscores: 'Meilleurs scores',
      you: 'Toi',
      friend: 'Ami',
      seedLabel: 'Seed',
      version: 'Version',
      skin_ember: 'Braise',
      skin_ion: 'Ion',
      skin_petal: 'Pétale',
      skin_static: 'Parasite',
      skin_prism: 'Prisme',
      skin_sunspot: 'Tache solaire',
      skin_void: 'Vide',
      skin_glitch: 'Glitch',
      theme_indigo: 'Indigo',
      theme_ember: 'Braise',
      theme_mint: 'Menthe',
      theme_vapor: 'Vapeur',
      theme_ink: 'Encre',
      rank_dust: 'Poussière',
      rank_pebble: 'Caillou',
      rank_meteor: 'Météore',
      rank_comet: 'Comète',
      rank_star: 'Étoile',
      rank_nova: 'Nova',
      rank_quasar: 'Quasar',
      mission_1: 'Frôle {n} planètes en une partie',
      mission_2: 'Encaisse {n} de style en une partie',
      mission_3: 'Atteins {n} m',
      mission_4: 'Fais {n} boucles en une partie',
      mission_5: 'Fais {n} tirs chauds en une partie',
      mission_6: 'Atteins la chaîne x{n}',
      mission_7: "Termine {n} parties au-dessus de 200 m aujourd'hui",
      mission_8: "Encaisse dans {n} parties différentes aujourd'hui",
      mission_9: 'Joue au Quotidien',
      mission_10: 'Atteins 150 m sans frôler',
      mission_11: 'Survis {n} s en une partie',
      mission_12: 'Bats ton record',
      medal_bronze: 'Bronze',
      medal_silver: 'Argent',
      medal_gold: 'Or',
      holdToPlay: 'MAINTIENS POUR JOUER',
      releaseToFly: 'RELÂCHE pour voler',
      holdWhenGreen: "MAINTIENS quand l'anneau est vert",
      loopToBank: 'Tiens une BOUCLE COMPLÈTE pour ENCAISSER',
      leftOnTable: 'Tu as laissé {n} sur la table',
      rewindKeep: 'REMBOBINER – garde +{n}',
      doubleDust: 'Double poussière',
      trySkinAd: 'Essayer (pub)',
      duelVs: 'DUEL vs {name}',
      fellHere: '{name} est tombé ici',
      linePassed: 'LIGNE FRANCHIE',
      youBeat: 'Tu as battu {name} de {n} m',
      challenge: 'Défi',
      dailyNumber: 'Quotidien #{n}',
      lifetimeToGo: 'encore {n} m',
      aimGuide: 'Guide de visée',
      reduceMotion: 'Réduire les animations',
      proMode: 'Mode pro',
      fell: 'CHUTE',
      burned: 'BRÛLÉ',
      crashed: 'CRASH',
      dust: 'Poussière',
      style: 'Style',
      alt: 'Alt',
      chain: 'Chaîne',
      views: 'Vues {a}/{b}',
      resetsIn: 'Réinitialisation dans {t}',
      yesterday: 'Hier',
      playDaily: 'Jouer au Quotidien',
      shareDaily: 'Partager le Quotidien',
      bank: 'Banque',
      heat: 'Chaleur',
      noAdNow: "Aucune pub disponible pour l'instant",
      longPressSave: 'Appui long pour enregistrer',
      shareToChat: 'Partager dans le chat',
      copyLink: 'Copier le lien',
      name: 'Nom',
      duelWon: 'Duel gagné !',
      pressToResume: 'Appuie pour reprendre',
      progressSessionOnly: "La progression n'est sauvegardée que pour cette session",
      cosmos: 'Cosmos {seed}',
      beatMe: 'BATS-MOI',
      tapToRetry: 'Touche pour réessayer',
      death: 'Mort'
    },

    id: {
      play: 'Main',
      tapToStart: 'Ketuk untuk mulai',
      tapOrSpace: 'Ketuk atau tekan Spasi',
      gameOver: 'Game Over',
      score: 'Skor',
      best: 'Terbaik',
      newBest: 'Rekor Baru!',
      continue: 'Lanjut',
      watchAdToContinue: 'Tonton iklan, lanjut',
      continueFree: 'Lanjut gratis',
      skipAd: 'Lewati iklan',
      retry: 'Coba lagi',
      home: 'Beranda',
      pause: 'Jeda',
      resume: 'Lanjutkan',
      settings: 'Pengaturan',
      sound: 'Suara',
      music: 'Musik',
      haptics: 'Getaran',
      language: 'Bahasa',
      on: 'Aktif',
      off: 'Nonaktif',
      share: 'Bagikan',
      shareText: 'Skorku {score}, bisa kalahkan aku? {url}',
      copied: 'Tersalin!',
      linkCopied: 'Tautan tersalin',
      challengeFriend: 'Tantang teman',
      daily: 'Harian',
      dailyChallenge: 'Tantangan Harian',
      dailyDone: 'Selesai untuk hari ini! Kembali besok.',
      dailyRank: 'Peringkat hari ini',
      streak: 'Streak',
      missions: 'Misi',
      missionDone: 'Misi selesai!',
      claim: 'Klaim',
      coins: 'Koin',
      skins: 'Skin',
      themes: 'Tema',
      locked: 'Terkunci',
      unlocked: 'Terbuka!',
      unlockFor: 'Buka dengan {cost}',
      equip: 'Pakai',
      equipped: 'Dipakai',
      howToPlay: 'Cara bermain',
      loading: 'Memuat…',
      adNotAvailable: 'Iklan belum tersedia',
      adLoading: 'Memuat iklan…',
      rewardGranted: 'Hadiah diterima!',
      noThanks: 'Tidak, terima kasih',
      close: 'Tutup',
      back: 'Kembali',
      yes: 'Ya',
      no: 'Tidak',
      ok: 'OK',
      cancel: 'Batal',
      comingSoon: 'Segera hadir',
      support: 'Bantuan',
      rate: 'Beri nilai',
      more: 'Lainnya',
      beatYourBest: 'Pecahkan rekormu!',
      playAgain: 'Main lagi',
      newRecord: 'Rekor baru!',
      combo: 'Kombo',
      perfect: 'Sempurna!',
      great: 'Hebat!',
      good: 'Bagus',
      miss: 'Meleset',
      level: 'Level',
      round: 'Ronde',
      time: 'Waktu',
      highscores: 'Skor tertinggi',
      you: 'Kamu',
      friend: 'Teman',
      seedLabel: 'Seed',
      version: 'Versi',
      skin_ember: 'Bara',
      skin_ion: 'Ion',
      skin_petal: 'Kelopak',
      skin_static: 'Statis',
      skin_prism: 'Prisma',
      skin_sunspot: 'Bintik Surya',
      skin_void: 'Hampa',
      skin_glitch: 'Glitch',
      theme_indigo: 'Nila',
      theme_ember: 'Bara',
      theme_mint: 'Mint',
      theme_vapor: 'Uap',
      theme_ink: 'Tinta',
      rank_dust: 'Debu',
      rank_pebble: 'Kerikil',
      rank_meteor: 'Meteor',
      rank_comet: 'Komet',
      rank_star: 'Bintang',
      rank_nova: 'Nova',
      rank_quasar: 'Kuasar',
      mission_1: 'Serempet {n} planet dalam satu lari',
      mission_2: 'Simpan {n} gaya dalam satu lari',
      mission_3: 'Capai {n} m',
      mission_4: 'Putar {n} kali dalam satu lari',
      mission_5: 'Lakukan {n} tembakan panas dalam satu lari',
      mission_6: 'Capai rantai x{n}',
      mission_7: 'Selesaikan {n} lari di atas 200 m hari ini',
      mission_8: 'Simpan poin di {n} lari berbeda hari ini',
      mission_9: 'Mainkan Harian',
      mission_10: 'Capai 150 m tanpa serempetan',
      mission_11: 'Bertahan {n} detik dalam satu lari',
      mission_12: 'Pecahkan rekormu',
      medal_bronze: 'Perunggu',
      medal_silver: 'Perak',
      medal_gold: 'Emas',
      holdToPlay: 'TAHAN UNTUK MAIN',
      releaseToFly: 'LEPAS untuk terbang',
      holdWhenGreen: 'TAHAN saat cincin hijau',
      loopToBank: 'Tahan SATU PUTARAN PENUH untuk MENYIMPAN',
      leftOnTable: 'Kamu meninggalkan {n} di meja',
      rewindKeep: 'PUTAR BALIK – simpan +{n}',
      doubleDust: 'Debu Ganda',
      trySkinAd: 'Coba (iklan)',
      duelVs: 'DUEL vs {name}',
      fellHere: '{name} jatuh di sini',
      linePassed: 'GARIS DILEWATI',
      youBeat: 'Kamu mengalahkan {name} dengan {n} m',
      challenge: 'Tantang',
      dailyNumber: 'Harian #{n}',
      lifetimeToGo: '{n} m lagi',
      aimGuide: 'Panduan arah',
      reduceMotion: 'Kurangi gerakan',
      proMode: 'Mode pro',
      fell: 'JATUH',
      burned: 'TERBAKAR',
      crashed: 'TABRAKAN',
      dust: 'Debu',
      style: 'Gaya',
      alt: 'Tinggi',
      chain: 'Rantai',
      views: 'Tayangan {a}/{b}',
      resetsIn: 'Reset dalam {t}',
      yesterday: 'Kemarin',
      playDaily: 'Main Harian',
      shareDaily: 'Bagikan Harian',
      bank: 'Simpan',
      heat: 'Panas',
      noAdNow: 'Belum ada iklan saat ini',
      longPressSave: 'Tekan lama untuk menyimpan',
      shareToChat: 'Bagikan ke chat',
      copyLink: 'Salin tautan',
      name: 'Nama',
      duelWon: 'Duel dimenangkan!',
      pressToResume: 'Tekan untuk lanjut',
      progressSessionOnly: 'Progres hanya tersimpan di sesi ini',
      cosmos: 'Kosmos {seed}',
      beatMe: 'KALAHKAN AKU',
      tapToRetry: 'Ketuk untuk coba lagi',
      death: 'Mati'
    },

    hi: {
      play: 'खेलें',
      tapToStart: 'शुरू करने के लिए टैप करें',
      tapOrSpace: 'टैप करें या Space दबाएँ',
      gameOver: 'गेम ओवर',
      score: 'स्कोर',
      best: 'बेस्ट',
      newBest: 'नया रिकॉर्ड!',
      continue: 'आगे बढ़ें',
      watchAdToContinue: 'विज्ञापन देखें',
      continueFree: 'मुफ़्त में आगे बढ़ें',
      skipAd: 'विज्ञापन छोड़ें',
      retry: 'फिर से',
      home: 'होम',
      pause: 'रोकें',
      resume: 'जारी रखें',
      settings: 'सेटिंग्स',
      sound: 'साउंड',
      music: 'म्यूज़िक',
      haptics: 'वाइब्रेशन',
      language: 'भाषा',
      on: 'चालू',
      off: 'बंद',
      share: 'शेयर करें',
      shareText: 'मैंने {score} स्कोर किया — क्या आप हरा सकते हैं? {url}',
      copied: 'कॉपी हो गया!',
      linkCopied: 'लिंक कॉपी हो गया',
      challengeFriend: 'दोस्त को चैलेंज करें',
      daily: 'डेली',
      dailyChallenge: 'डेली चैलेंज',
      dailyDone: 'आज का हो गया! कल फिर आएँ।',
      dailyRank: 'आज की रैंक',
      streak: 'स्ट्रीक',
      missions: 'मिशन',
      missionDone: 'मिशन पूरा!',
      claim: 'क्लेम करें',
      coins: 'कॉइन',
      skins: 'स्किन',
      themes: 'थीम',
      locked: 'लॉक्ड',
      unlocked: 'अनलॉक हो गया!',
      unlockFor: '{cost} में अनलॉक करें',
      equip: 'लगाएँ',
      equipped: 'लगा हुआ',
      howToPlay: 'कैसे खेलें',
      loading: 'लोड हो रहा है…',
      adNotAvailable: 'अभी कोई विज्ञापन उपलब्ध नहीं',
      adLoading: 'विज्ञापन लोड हो रहा है…',
      rewardGranted: 'इनाम मिल गया!',
      noThanks: 'नहीं, धन्यवाद',
      close: 'बंद करें',
      back: 'वापस',
      yes: 'हाँ',
      no: 'नहीं',
      ok: 'ठीक है',
      cancel: 'रद्द करें',
      comingSoon: 'जल्द आ रहा है',
      support: 'सहायता',
      rate: 'रेट करें',
      more: 'और',
      beatYourBest: 'अपना रिकॉर्ड तोड़ें!',
      playAgain: 'फिर खेलें',
      newRecord: 'नया रिकॉर्ड!',
      combo: 'कॉम्बो',
      perfect: 'परफ़ेक्ट!',
      great: 'शानदार!',
      good: 'अच्छा',
      miss: 'मिस',
      level: 'लेवल',
      round: 'राउंड',
      time: 'समय',
      highscores: 'टॉप स्कोर',
      you: 'आप',
      friend: 'दोस्त',
      seedLabel: 'सीड',
      version: 'वर्ज़न',
      skin_ember: 'अंगार',
      skin_ion: 'आयन',
      skin_petal: 'पंखुड़ी',
      skin_static: 'स्टैटिक',
      skin_prism: 'प्रिज़्म',
      skin_sunspot: 'सनस्पॉट',
      skin_void: 'शून्य',
      skin_glitch: 'ग्लिच',
      theme_indigo: 'इंडिगो',
      theme_ember: 'अंगार',
      theme_mint: 'मिंट',
      theme_vapor: 'वेपर',
      theme_ink: 'इंक',
      rank_dust: 'धूल',
      rank_pebble: 'कंकड़',
      rank_meteor: 'उल्का',
      rank_comet: 'धूमकेतु',
      rank_star: 'तारा',
      rank_nova: 'नोवा',
      rank_quasar: 'क्वासर',
      mission_1: 'एक रन में {n} ग्रहों को छूकर निकलो',
      mission_2: 'एक रन में {n} स्टाइल बैंक करो',
      mission_3: '{n} मी तक पहुँचो',
      mission_4: 'एक रन में {n} लूप लगाओ',
      mission_5: 'एक रन में {n} हॉट शॉट करो',
      mission_6: 'चेन x{n} तक पहुँचो',
      mission_7: 'आज {n} रन 200 मी से ऊपर पूरे करो',
      mission_8: 'आज {n} अलग रन में बैंक करो',
      mission_9: 'डेली खेलो',
      mission_10: 'बिना छुए 150 मी तक पहुँचो',
      mission_11: 'एक रन में {n} सेकंड टिके रहो',
      mission_12: 'अपना रिकॉर्ड तोड़ो',
      medal_bronze: 'कांस्य',
      medal_silver: 'रजत',
      medal_gold: 'स्वर्ण',
      holdToPlay: 'खेलने के लिए दबाए रखो',
      releaseToFly: 'उड़ने के लिए छोड़ो',
      holdWhenGreen: 'रिंग हरी हो तो दबाए रखो',
      loopToBank: 'बैंक करने के लिए पूरा लूप पकड़ो',
      leftOnTable: 'तुमने {n} टेबल पर छोड़ दिए',
      rewindKeep: 'रिवाइंड – +{n} बचाओ',
      doubleDust: 'दोगुनी धूल',
      trySkinAd: 'आज़माओ (विज्ञापन)',
      duelVs: 'द्वंद्व: {name}',
      fellHere: '{name} यहाँ गिरा',
      linePassed: 'रेखा पार',
      youBeat: 'तुमने {name} को {n} मी से हराया',
      challenge: 'चुनौती',
      dailyNumber: 'डेली #{n}',
      lifetimeToGo: '{n} मी बाकी',
      aimGuide: 'निशाना गाइड',
      reduceMotion: 'कम एनिमेशन',
      proMode: 'प्रो मोड',
      fell: 'गिरे',
      burned: 'जले',
      crashed: 'टकराए',
      dust: 'धूल',
      style: 'स्टाइल',
      alt: 'ऊँचाई',
      chain: 'चेन',
      views: 'व्यू {a}/{b}',
      resetsIn: '{t} में रीसेट',
      yesterday: 'कल',
      playDaily: 'डेली खेलो',
      shareDaily: 'डेली शेयर करो',
      bank: 'बैंक',
      heat: 'गर्मी',
      noAdNow: 'अभी कोई विज्ञापन नहीं',
      longPressSave: 'सेव करने के लिए देर तक दबाओ',
      shareToChat: 'चैट में भेजो',
      copyLink: 'लिंक कॉपी करो',
      name: 'नाम',
      duelWon: 'द्वंद्व जीता!',
      pressToResume: 'जारी रखने के लिए दबाओ',
      progressSessionOnly: 'प्रगति सिर्फ़ इस सेशन में सेव होगी',
      cosmos: 'कॉसमॉस {seed}',
      beatMe: 'मुझे हराओ',
      tapToRetry: 'फिर से खेलने के लिए टैप करो',
      death: 'मृत्यु'
    },

    ar: {
      play: 'العب',
      tapToStart: 'اضغط للبدء',
      tapOrSpace: 'اضغط أو زر المسافة',
      gameOver: 'انتهت اللعبة',
      score: 'النقاط',
      best: 'الأفضل',
      newBest: 'رقم قياسي جديد!',
      continue: 'متابعة',
      watchAdToContinue: 'شاهد إعلانًا وتابع',
      continueFree: 'متابعة مجانًا',
      skipAd: 'تخطّي الإعلان',
      retry: 'إعادة',
      home: 'الرئيسية',
      pause: 'إيقاف مؤقت',
      resume: 'استئناف',
      settings: 'الإعدادات',
      sound: 'الصوت',
      music: 'الموسيقى',
      haptics: 'الاهتزاز',
      language: 'اللغة',
      on: 'مفعّل',
      off: 'معطّل',
      share: 'مشاركة',
      shareText: 'سجّلت {score} نقطة — هل تتفوق عليّ؟ {url}',
      copied: 'تم النسخ!',
      linkCopied: 'تم نسخ الرابط',
      challengeFriend: 'تحدَّ صديقًا',
      daily: 'يومي',
      dailyChallenge: 'التحدي اليومي',
      dailyDone: 'انتهى تحدي اليوم! عُد غدًا.',
      dailyRank: 'ترتيب اليوم',
      streak: 'سلسلة',
      missions: 'المهام',
      missionDone: 'تمت المهمة!',
      claim: 'استلام',
      coins: 'العملات',
      skins: 'الأشكال',
      themes: 'السمات',
      locked: 'مقفل',
      unlocked: 'تم الفتح!',
      unlockFor: 'افتح بـ {cost}',
      equip: 'تجهيز',
      equipped: 'مُجهّز',
      howToPlay: 'طريقة اللعب',
      loading: 'جارٍ التحميل…',
      adNotAvailable: 'لا يوجد إعلان متاح الآن',
      adLoading: 'جارٍ تحميل الإعلان…',
      rewardGranted: 'تم استلام المكافأة!',
      noThanks: 'لا، شكرًا',
      close: 'إغلاق',
      back: 'رجوع',
      yes: 'نعم',
      no: 'لا',
      ok: 'حسنًا',
      cancel: 'إلغاء',
      comingSoon: 'قريبًا',
      support: 'الدعم',
      rate: 'قيّمنا',
      more: 'المزيد',
      beatYourBest: 'حطّم رقمك القياسي!',
      playAgain: 'العب مجددًا',
      newRecord: 'رقم قياسي جديد!',
      combo: 'كومبو',
      perfect: 'مثالي!',
      great: 'رائع!',
      good: 'جيد',
      miss: 'خطأ',
      level: 'المستوى',
      round: 'الجولة',
      time: 'الوقت',
      highscores: 'أعلى النتائج',
      you: 'أنت',
      friend: 'صديق',
      seedLabel: 'Seed',
      version: 'الإصدار',
      skin_ember: 'جمرة',
      skin_ion: 'أيون',
      skin_petal: 'بتلة',
      skin_static: 'تشويش',
      skin_prism: 'منشور',
      skin_sunspot: 'بقعة شمسية',
      skin_void: 'الفراغ',
      skin_glitch: 'خلل',
      theme_indigo: 'نيلي',
      theme_ember: 'جمرة',
      theme_mint: 'نعناع',
      theme_vapor: 'بخار',
      theme_ink: 'حبر',
      rank_dust: 'غبار',
      rank_pebble: 'حصاة',
      rank_meteor: 'شهاب',
      rank_comet: 'مذنّب',
      rank_star: 'نجم',
      rank_nova: 'مستعر',
      rank_quasar: 'كوازار',
      mission_1: 'المس {n} كواكب في جولة واحدة',
      mission_2: 'احفظ {n} نقطة أسلوب في جولة واحدة',
      mission_3: 'اصعد إلى {n} م',
      mission_4: 'أكمل {n} دورات في جولة واحدة',
      mission_5: 'نفّذ {n} إطلاقات ساخنة في جولة واحدة',
      mission_6: 'اصل إلى سلسلة x{n}',
      mission_7: 'أنهِ {n} جولات فوق 200 م اليوم',
      mission_8: 'احفظ النقاط في {n} جولات مختلفة اليوم',
      mission_9: 'العب التحدي اليومي',
      mission_10: 'اصعد إلى 150 م دون أي لمس',
      mission_11: 'انجُ {n} ثانية في جولة واحدة',
      mission_12: 'حطّم رقمك القياسي',
      medal_bronze: 'برونزية',
      medal_silver: 'فضية',
      medal_gold: 'ذهبية',
      holdToPlay: 'اضغط مطوّلاً للعب',
      releaseToFly: 'أفلت لتطير',
      holdWhenGreen: 'اضغط مطوّلاً عندما تكون الحلقة خضراء',
      loopToBank: 'أكمل دورة كاملة لتحفظ النقاط',
      leftOnTable: 'تركت {n} على الطاولة',
      rewindKeep: 'ارجع – احتفظ بـ +{n}',
      doubleDust: 'ضاعف الغبار',
      trySkinAd: 'جرّب (إعلان)',
      duelVs: 'مبارزة ضد {name}',
      fellHere: '{name} سقط هنا',
      linePassed: 'تجاوزت الخط',
      youBeat: 'تغلّبت على {name} بفارق {n} م',
      challenge: 'تحدٍّ',
      dailyNumber: 'اليومي #{n}',
      lifetimeToGo: 'بقي {n} م',
      aimGuide: 'دليل التصويب',
      reduceMotion: 'تقليل الحركة',
      proMode: 'وضع المحترفين',
      fell: 'سقطت',
      burned: 'احترقت',
      crashed: 'تحطّمت',
      dust: 'غبار',
      style: 'أسلوب',
      alt: 'ارتفاع',
      chain: 'سلسلة',
      views: 'مشاهدات {a}/{b}',
      resetsIn: 'يتجدد خلال {t}',
      yesterday: 'أمس',
      playDaily: 'العب اليومي',
      shareDaily: 'شارك اليومي',
      bank: 'حفظ',
      heat: 'حرارة',
      noAdNow: 'لا يوجد إعلان الآن',
      longPressSave: 'اضغط مطوّلاً للحفظ',
      shareToChat: 'شارك في الدردشة',
      copyLink: 'نسخ الرابط',
      name: 'الاسم',
      duelWon: 'فزت بالمبارزة!',
      pressToResume: 'اضغط للمتابعة',
      progressSessionOnly: 'يُحفظ التقدم في هذه الجلسة فقط',
      cosmos: 'الكون {seed}',
      beatMe: 'تغلّب عليّ',
      tapToRetry: 'انقر لإعادة المحاولة',
      death: 'موت'
    }
  };

  /** Menu order for the language picker. */
  var AVAILABLE = ['en', 'tr', 'ru', 'es', 'pt', 'de', 'fr', 'id', 'hi', 'ar'];

  /** Endonyms shown in the language picker. */
  var NATIVE_NAMES = {
    en: 'English',
    tr: 'Türkçe',
    ru: 'Русский',
    es: 'Español',
    pt: 'Português',
    de: 'Deutsch',
    fr: 'Français',
    id: 'Bahasa Indonesia',
    hi: 'हिन्दी',
    ar: 'العربية'
  };

  /** Languages written right-to-left. */
  var RTL = { ar: true };

  /**
   * Intl locale per language. Arabic is forced to Latin digits ("1,234"), which is
   * what players expect in score displays; Hindi keeps its lakh grouping (12,34,567).
   */
  var LOCALES = {
    en: 'en-US', tr: 'tr-TR', ru: 'ru-RU', es: 'es-ES', pt: 'pt-BR',
    de: 'de-DE', fr: 'fr-FR', id: 'id-ID', hi: 'hi-IN', ar: 'ar-u-nu-latn'
  };

  /** Legacy / alias subtags that browsers still emit. */
  var ALIASES = { in: 'id' };

  var DEFAULT_LANG = 'en';
  var STORAGE_KEY = 'lang';

  var current = DEFAULT_LANG;
  var formatters = {};

  /**
   * Own-property lookup. Every table above is a plain object, so a key such as
   * 'constructor' or '__proto__' would otherwise resolve through Object.prototype.
   * @param {Object} table
   * @param {*} key
   * @returns {*} the value, or undefined when `table` has no own property `key`
   */
  function own(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  }

  // ---------------------------------------------------------------------------
  // Language resolution
  // ---------------------------------------------------------------------------

  /**
   * Reduce a BCP-47 tag ("pt-BR", "zh_Hans", "IN") to a supported code, or null.
   * @param {*} tag
   * @returns {string|null}
   */
  function normalize(tag) {
    if (typeof tag !== 'string') return null;
    var primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    primary = own(ALIASES, primary) || primary;
    return own(STRINGS, primary) ? primary : null;
  }

  /**
   * First supported code from a list of BCP-47 tags.
   * @param {Array<string>|string|undefined} list
   * @returns {string|null}
   */
  function firstSupported(list) {
    if (typeof list === 'string') list = [list];
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      var code = normalize(list[i]);
      if (code) return code;
    }
    return null;
  }

  /** Browser language preferences, most preferred first. */
  function navigatorLanguages() {
    var nav = window.navigator;
    if (!nav) return [];
    if (Array.isArray(nav.languages) && nav.languages.length) return nav.languages;
    return nav.language ? [nav.language] : [];
  }

  /** `?lang=xx` from the page URL, if present. */
  function urlLang() {
    var search = (window.location && window.location.search) || '';
    var match = /[?&]lang=([^&#]+)/.exec(search);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
  }

  /** Language the player explicitly chose earlier (persisted by setLang). */
  function storedLang() {
    var storage = G.storage;
    if (!storage || typeof storage.get !== 'function') return null;
    try { return storage.get(STORAGE_KEY, null); } catch (e) { return null; }
  }

  /** Language reported by the hosting platform's user profile (Telegram, CrazyGames). */
  function sdkLang() {
    try {
      var user = G.sdk && G.sdk.user;
      return user ? user.lang : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Detect the best supported language from a preference list.
   * @param {Array<string>} [list] BCP-47 tags; defaults to navigator.languages.
   * @returns {string} a supported code ('en' when nothing matches)
   */
  function detect(list) {
    return firstSupported(list === undefined ? navigatorLanguages() : list) || DEFAULT_LANG;
  }

  // ---------------------------------------------------------------------------
  // Applying a language
  // ---------------------------------------------------------------------------

  /**
   * Writing direction for a language.
   * @param {string} [code] defaults to the current language
   * @returns {'rtl'|'ltr'}
   */
  function dir(code) {
    return own(RTL, code || current) ? 'rtl' : 'ltr';
  }

  /** Reflect the current language on <html lang dir> so CSS and screen readers follow. */
  function applyToDocument() {
    var root = window.document && window.document.documentElement;
    if (!root || typeof root.setAttribute !== 'function') return;
    root.setAttribute('lang', current);
    root.setAttribute('dir', dir(current));
  }

  /** Persist the player's explicit choice; silently ignores a missing/broken storage module. */
  function persist(code) {
    var storage = G.storage;
    if (!storage || typeof storage.set !== 'function') return;
    try { storage.set(STORAGE_KEY, code); } catch (e) { G.log('[i18n] persist failed', e); }
  }

  /**
   * Build the 'g:lang' event. Older WebViews expose CustomEvent as an object
   * rather than a constructor, so fall back to document.createEvent there.
   * @param {{lang: string, dir: string}} detail
   * @returns {Event|null}
   */
  function createLangEvent(detail) {
    if (typeof window.CustomEvent === 'function') {
      return new window.CustomEvent('g:lang', { detail: detail });
    }
    var doc = window.document;
    if (!doc || typeof doc.createEvent !== 'function') return null;
    var legacy = doc.createEvent('CustomEvent');
    legacy.initCustomEvent('g:lang', false, false, detail);
    return legacy;
  }

  /** Notify the rest of the game that strings changed. */
  function emitChange() {
    if (typeof window.dispatchEvent !== 'function') return;
    try {
      var event = createLangEvent({ lang: current, dir: dir(current) });
      if (event) window.dispatchEvent(event);
    } catch (e) {
      G.log('[i18n] event dispatch failed', e);
    }
  }

  /**
   * Choose the active language. Candidates are tried in order and the first one
   * that maps to a supported language wins (an unsupported `?lang=xx` therefore
   * falls through to the next source instead of straight to the default):
   *   opts.lang → URL ?lang= → saved choice (G.storage 'lang') → G.sdk.user.lang → navigator.languages → 'en'.
   * Also sets <html lang> and <html dir>. Safe to call more than once.
   * @param {{lang?: string}} [opts]
   * @returns {string} the chosen language code
   */
  function init(opts) {
    var candidates = [opts && opts.lang, urlLang(), storedLang(), sdkLang()];
    current = firstSupported(candidates) || detect();
    applyToDocument();
    G.log('[i18n] init →', current);
    return current;
  }

  /**
   * Switch language at runtime, persist it and dispatch window event 'g:lang'.
   * Unsupported codes are ignored (logged in debug) and the current language is kept.
   * @param {string} code supported language code, e.g. 'tr'
   * @returns {string} the language that is active after the call
   */
  function setLang(code) {
    var next = normalize(code);
    if (!next) {
      G.log('[i18n] unsupported language:', code);
      return current;
    }
    current = next;
    persist(next);
    applyToDocument();
    emitChange();
    return current;
  }

  // ---------------------------------------------------------------------------
  // Lookup & formatting
  // ---------------------------------------------------------------------------

  /**
   * Fill `{name}` placeholders. Unknown placeholders are left intact so a missing
   * variable is visible in QA instead of silently vanishing.
   * @param {string} text
   * @param {Object} vars
   * @returns {string}
   */
  function interpolate(text, vars) {
    return text.replace(/\{([A-Za-z0-9_]+)\}/g, function (whole, name) {
      var value = vars[name];
      return value === undefined || value === null ? whole : String(value);
    });
  }

  /**
   * String for `key` in `table`, or undefined. Only own string values count, so a
   * key like 'constructor' never leaks an Object.prototype member into the UI.
   * @param {Object<string, string>} table
   * @param {*} key
   * @returns {string|undefined}
   */
  function lookup(table, key) {
    var text = own(table, key);
    return typeof text === 'string' ? text : undefined;
  }

  /**
   * Translate a key in the current language, falling back to English, then to the key itself.
   * @param {string} key
   * @param {Object<string, *>} [vars] values for `{name}` placeholders
   * @returns {string}
   */
  function t(key, vars) {
    var text = lookup(STRINGS[current], key);
    if (text === undefined) text = lookup(STRINGS[DEFAULT_LANG], key);
    if (text === undefined) {
      G.log('[i18n] missing key:', key);
      return String(key);
    }
    return vars && typeof vars === 'object' ? interpolate(text, vars) : text;
  }

  /**
   * Whether the master table defines a key.
   * @param {string} key
   * @returns {boolean}
   */
  function has(key) {
    return lookup(STRINGS[DEFAULT_LANG], key) !== undefined;
  }

  /**
   * Endonym for the language picker.
   * @param {string} code
   * @returns {string} e.g. 'Türkçe'; falls back to the code itself
   */
  function nativeName(code) {
    return lookup(NATIVE_NAMES, code) || String(code);
  }

  /**
   * Plain thousands grouping used when Intl is unavailable. Values at or above
   * 1e21 would stringify in exponent form, so those go through BigInt when present.
   * @param {number} n integer
   * @returns {string}
   */
  function groupFallback(n) {
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    var digits = abs >= 1e21 && typeof BigInt === 'function' ? BigInt(abs).toString() : String(abs);
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * Format an integer with locale grouping (score counters, coin balances).
   * Non-finite input yields '0'; fractions are rounded; -0 prints as '0'.
   * @param {number} n
   * @returns {string}
   */
  function fmtNumber(n) {
    var value = Math.round(Number(n));
    if (!isFinite(value) || value === 0) value = 0;
    var formatter = formatters[current];
    if (formatter === undefined) {
      try {
        formatter = new Intl.NumberFormat(own(LOCALES, current) || current, { maximumFractionDigits: 0 });
      } catch (e) {
        formatter = null;
      }
      formatters[current] = formatter;
    }
    return formatter ? formatter.format(value) : groupFallback(value);
  }

  /**
   * Translate static markup in place:
   *   <span data-i18n="play"></span>            → textContent
   *   <button data-i18n-title="close"></button>  → title + aria-label
   * Call again after setLang (or listen for 'g:lang') to refresh.
   * @param {ParentNode} [root] defaults to document
   */
  function apply(root) {
    var scope = root || window.document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    var i, el, nodes;
    nodes = scope.querySelectorAll('[data-i18n]');
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      el.textContent = t(el.getAttribute('data-i18n'));
    }
    nodes = scope.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      var label = t(el.getAttribute('data-i18n-title'));
      el.setAttribute('title', label);
      el.setAttribute('aria-label', label);
    }
  }

  // ---------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------
  var i18n = {
    STRINGS: STRINGS,
    init: init,
    t: t,
    has: has,
    setLang: setLang,
    detect: detect,
    dir: dir,
    nativeName: nativeName,
    fmtNumber: fmtNumber,
    apply: apply
  };

  Object.defineProperty(i18n, 'lang', {
    enumerable: true,
    /** @returns {string} current language code */
    get: function () { return current; }
  });

  Object.defineProperty(i18n, 'available', {
    enumerable: true,
    /** @returns {string[]} supported codes in menu order (fresh copy) */
    get: function () { return AVAILABLE.slice(); }
  });

  Object.defineProperty(i18n, 'isRtl', {
    enumerable: true,
    /** @returns {boolean} true when the current language runs right-to-left */
    get: function () { return !!RTL[current]; }
  });

  G.i18n = i18n;
})();

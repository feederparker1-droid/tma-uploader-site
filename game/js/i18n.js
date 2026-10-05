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
      version: 'Version'
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
      version: 'Sürüm'
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
      version: 'Версия'
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
      version: 'Versión'
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
      version: 'Versão'
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
      version: 'Version'
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
      version: 'Version'
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
      version: 'Versi'
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
      version: 'वर्ज़न'
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
      version: 'الإصدار'
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
    primary = ALIASES[primary] || primary;
    return STRINGS[primary] ? primary : null;
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
    var user = G.sdk && G.sdk.user;
    return user ? user.lang : null;
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
    return RTL[code || current] ? 'rtl' : 'ltr';
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

  /** Notify the rest of the game that strings changed. */
  function emitChange() {
    if (typeof window.CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    try {
      window.dispatchEvent(new window.CustomEvent('g:lang', { detail: { lang: current, dir: dir(current) } }));
    } catch (e) {
      G.log('[i18n] event dispatch failed', e);
    }
  }

  /**
   * Choose the active language. Precedence, first hit wins:
   *   opts.lang → URL ?lang= → saved choice (G.storage 'lang') → G.sdk.user.lang → navigator.languages → 'en'.
   * Also sets <html lang> and <html dir>. Safe to call more than once.
   * @param {{lang?: string}} [opts]
   * @returns {string} the chosen language code
   */
  function init(opts) {
    var wanted = (opts && opts.lang) || urlLang() || storedLang() || sdkLang();
    current = normalize(wanted) || detect();
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
   * Translate a key in the current language, falling back to English, then to the key itself.
   * @param {string} key
   * @param {Object<string, *>} [vars] values for `{name}` placeholders
   * @returns {string}
   */
  function t(key, vars) {
    var table = STRINGS[current] || STRINGS[DEFAULT_LANG];
    var text = table[key];
    if (text === undefined) text = STRINGS[DEFAULT_LANG][key];
    if (text === undefined) {
      G.log('[i18n] missing key:', key);
      return String(key);
    }
    return vars ? interpolate(text, vars) : text;
  }

  /**
   * Whether the master table defines a key.
   * @param {string} key
   * @returns {boolean}
   */
  function has(key) {
    return Object.prototype.hasOwnProperty.call(STRINGS[DEFAULT_LANG], key);
  }

  /**
   * Endonym for the language picker.
   * @param {string} code
   * @returns {string} e.g. 'Türkçe'; falls back to the code itself
   */
  function nativeName(code) {
    return NATIVE_NAMES[code] || String(code);
  }

  /** Plain thousands grouping used when Intl is unavailable. */
  function groupFallback(n) {
    var sign = n < 0 ? '-' : '';
    var digits = String(Math.abs(n));
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * Format an integer with locale grouping (score counters, coin balances).
   * Non-finite input yields '0'; fractions are rounded.
   * @param {number} n
   * @returns {string}
   */
  function fmtNumber(n) {
    var value = Math.round(Number(n));
    if (!isFinite(value)) value = 0;
    var formatter = formatters[current];
    if (formatter === undefined) {
      try {
        formatter = new Intl.NumberFormat(LOCALES[current] || current, { maximumFractionDigits: 0 });
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

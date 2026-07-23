// Корневой экран /menu: одно сообщение, кнопки по две в ряд (паттерн hermes). Все кнопки
// несут либо навигацию (o-верб к под-экрану), либо хендофф (mdl/thk), либо закрытие (r:x) —
// их целиком обрабатывает движок, поэтому on() тут пустой.
//
// Правило репо: ни одной module-level const с переведённой строкой — все подписи собираются
// в render() через ctx.tr, иначе язык замёрзнет до рестарта.
export default {
  parent: null,
  render(st, ctx) {
    const b = ctx.btn;
    const T = ctx.tr;
    const rows = [
      [b(T("🧠 Model", "🧠 Модель"), "iva_menu:mdl"), b(T("🤔 Thinking", "🤔 Размышления"), "iva_menu:thk")],
      [b(T("🔍 Search", "🔍 Поиск"), "iva_menu:srch:o"), b(T("🌐 Language", "🌐 Язык"), "iva_menu:lang:o")],
      [b(T("🎭 Character", "🎭 Характер"), "iva_menu:chr:o"), b(T("💾 Memory", "💾 Память"), "iva_menu:core:o")],
      [b(T("📡 Userbot", "📡 Userbot"), "iva_menu:ub:o"), b(T("🔗 Google", "🔗 Google"), "iva_menu:gws:o")],
      [b(T("⏰ Timers", "⏰ Кроны"), "iva_menu:cron:o"), b(T("🧩 Skills", "🧩 Скиллы"), "iva_menu:sk:o")],
      [b(T("📊 Status", "📊 Статус"), "iva_menu:st:o"), b(T("✖ Close", "✖ Закрыть"), "iva_menu:r:x")],
    ];
    return { text: T("⚙️ Settings\n\nPick a section.", "⚙️ Настройки\n\nВыбери раздел."), rows };
  },
  on() {},
};

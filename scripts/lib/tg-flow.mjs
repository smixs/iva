// Session-store для out-of-band диалогов Telegram (/model, /think, /menu и будущие
// флоу). Извлечено из scripts/telegram-poll.mjs:349-409 без изменения поведения:
// один слот на пару (chatId, userId), каждый флоу правит ОДНО своё сообщение.
//
// Общий стор — то, что делает однозначным «чей следующий текст в чате»: пока висит
// awaitText, ввод принадлежит текущему флоу этого пользователя, а не eve.
//
// Состояние живёт только в памяти этого процесса. Рестарт моста теряет его —
// протухший тап по кнопке ловится диспатчером как «диалог устарел».

const TTL_MS = 15 * 60 * 1000; // как WIZARD_TTL_MS — совпадает с временем жизни codex device-code

// tg(method, params) -> { ok, result, description } (тонкая обёртка над Bot API моста).
// log принимается по контракту для будущих обработчиков; примитивы ниже не логируют —
// поведение обязано остаться дословным (тихий фолбэк при неудачной правке).
export function createFlows({ tg, log = () => {} }) {
  const flows = new Map(); // был `wizards`; ключ `${chatId}:${userId}`

  const key = (chatId, userId) => `${chatId}:${userId}`;

  // getWizard :371 — TTL-очистка при чтении. Континуации (codex-login) сверяют
  // identity: `flows.get(...) !== st` истинно и когда слот заменён, и когда протух.
  function get(chatId, userId) {
    const k = key(chatId, userId);
    const st = flows.get(k);
    if (st && Date.now() - st.createdAt > TTL_MS) {
      flows.delete(k);
      return null;
    }
    return st ?? null;
  }

  // newWizard :383 — identity-replace: перезаписывает любой ждущий флоу этого юзера.
  // Осиротевшие async-континуации старого объекта сверяют identity против стора и
  // сами себя отбрасывают. extra подмешивает поля в свежий стейт (напр. msgId меню).
  function start(chatId, userId, flow, extra = {}) {
    const st = {
      flow, chatId, userId, createdAt: Date.now(),
      msgId: null, provider: null, models: null, model: null, effort: null,
      awaitText: null, // обобщение awaitKey (:388): { kind, secret, data }
      screen: null, page: 0, data: {},
      ...extra,
    };
    flows.set(key(chatId, userId), st);
    return st;
  }

  // Продлевает жизнь стейта. Зовёт только движок меню на каждом взаимодействии —
  // активные квиз/интервью не протухают на полуслове. Визарды /model//think НЕ
  // трогаются: их TTL намеренно равен времени жизни codex device-code.
  function touch(st) {
    st.createdAt = Date.now();
  }

  // wizScreen :393 — правит единственное сообщение флоу на месте (первый раз шлёт).
  async function screen(st, text, rows) {
    const reply_markup = rows ? { inline_keyboard: rows } : undefined;
    if (st.msgId) {
      const r = await tg("editMessageText", { chat_id: st.chatId, message_id: st.msgId, text, reply_markup });
      // «message is not modified» = двойной тап перерисовал тот же экран — это успех, не сбой.
      if (r.ok || /not modified/i.test(r.description || "")) return;
      // правка не удалась (сообщение слишком старое / удалено) — падаем на свежее сообщение
    }
    const r = await tg("sendMessage", { chat_id: st.chatId, text, reply_markup });
    if (r.ok) st.msgId = r.result.message_id;
  }

  // endWizard :406 — снимает стейт и показывает финальный экран. НОВОЕ: опциональные
  // rows (терминальный экран может нести кнопку «‹ Меню» — возврат в меню).
  async function end(st, text, rows) {
    flows.delete(key(st.chatId, st.userId));
    await screen(st, text, rows);
  }

  return { key, get, start, touch, screen, end };
}

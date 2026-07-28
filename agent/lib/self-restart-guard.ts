// Жёсткий запрет самоубийственных команд в bash-туле (issue #68).
//
// Механика бага: агент исполняет `iva restart` посреди собственного хода → процесс eve
// умирает, ход навсегда остаётся в статусе running. Durable-execution переигрывает его
// при КАЖДОМ старте сервиса ("Re-enqueued N active run(s) on startup"), доходит до того же
// шага с рестартом и снова убивает сервис — бесконечный цикл. Заодно не освобождается
// continuation-hook, и все новые сообщения падают с HookConflictError — бот немеет.
//
// Промпт-запрет в instructions.md модели игнорируют (deepseek в #68 сделал это дважды),
// поэтому блокируем детерминированно, ДО exec. Это защита от выстрела себе в ногу, а не
// security-граница: у bash полный host-доступ, обойти можно всегда — цель в том, чтобы
// модель не сделала это СЛУЧАЙНО по прямой просьбе из чата.
//
// Намеренно НЕ блокируем: status/journalctl по любым юнитам, рестарт таймеров iva-memory-*
// и моста iva-telegram-poll (они не убивают процесс агента), iva doctor/usage/login,
// eve build. Ложное срабатывание на невинной команде хуже узкой дыры: модель получает
// понятную ошибку и переформулирует, а вот немой бот из #68 сам не чинится.

// Сам CLI: iva restart|stop|reset|full-reset все останавливают iva.service; iva update
// перезапускает его в конце. Ловим и прямые вызовы файла (bin/iva.mjs restart) и форму
// с разделителем аргументов (npm run iva -- restart). Перед "iva" — не-словесный символ
// или начало строки, чтобы не матчить чужие слова с "iva" внутри.
const IVA_CLI_LETHAL =
  /(?:^|[^\w-])iva(?:\.mjs)?\s+(?:--\s+)?(?:restart|stop|reset|full-reset|update)(?![\w-])/;

// systemctl с летальным глаголом, у которого среди юнитов-аргументов есть ровно "iva" или
// "iva.service". [^;&|]* не даёт глаголу из одной команды дотянуться до юнита из следующей
// в цепочке (`systemctl stop foo; systemctl status iva` — не матчится).
const SYSTEMCTL_LETHAL =
  /systemctl\b[^;&|]*\b(?:restart|try-restart|reload-or-restart|stop|kill)\s+(?:[\w@.:-]+\s+)*iva(?:\.service)?(?![\w-])/;

// pkill/killall по node/eve/iva кладут сам процесс eve-сервера (и мост заодно).
const PKILL_LETHAL = /\b(?:pkill|killall)\b[^;&|]*\b(?:node|eve|iva)(?![\w-])/;

const RULES: Array<{ re: RegExp; what: string }> = [
  { re: IVA_CLI_LETHAL, what: "команда iva, останавливающая/перезапускающая сервис" },
  { re: SYSTEMCTL_LETHAL, what: "systemctl restart/stop/kill юнита iva.service" },
  { re: PKILL_LETHAL, what: "pkill/killall по процессу node/eve/iva" },
];

/**
 * Возвращает текст отказа, если команда убила бы процесс самой Ивы посреди хода,
 * иначе null. Текст адресован модели: объясняет, почему нельзя, и что предложить.
 */
export function selfRestartViolation(command: string): string | null {
  for (const { re, what } of RULES) {
    if (re.test(command)) {
      return (
        `ЗАБЛОКИРОВАНО: ${what}. Это убьёт процесс самой Ивы посреди текущего хода — ` +
        `ход навсегда зависнет в running, сервис уйдёт в цикл перезапусков, а бот замолчит ` +
        `с HookConflictError (issue #68). Перезапуск инициирует только пользователь: ` +
        `предложи ему /restart прямо в чате (для обновления — /update), ` +
        `либо \`iva restart\` / \`iva update\` в терминале на сервере.`
      );
    }
  }
  return null;
}

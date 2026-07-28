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
// Матчим не сырую строку, а КОМАНДНЫЕ ПОЗИЦИИ: строку чистим от кавычек (shell их снимет
// перед исполнением — `iva "restart"` летален ровно так же), режем на сегменты по
// разделителям команд и с начала каждого сегмента снимаем обёртки (sudo, env, timeout,
// bash -c…). Поэтому `rg -n 'iva restart' docs/` и `echo "iva restart"` проходят — там
// "iva" аргумент, а не команда, — а любая форма реального вызова ловится.
//
// Намеренно НЕ блокируем: status/journalctl по любым юнитам, рестарт таймеров iva-memory-*
// и моста iva-telegram-poll (они не убивают процесс агента), iva usage/login, eve build.
// iva doctor ЗАБЛОКИРОВАН: его ремонтные ветки (перегенерация bearer, exposed-listener)
// сами рестартуют iva.service (bin/iva.mjs) — из чата доктора запускает кнопка в /menu,
// она идёт через мост, не через агента.

// Кавычки и экранирование убираем ДО матчинга: для наших паттернов (имена команд и юнитов
// без пробелов) снятие кавычек эквивалентно тому, что увидит execve после разбора shell.
function normalize(command: string): string {
  return command.replace(/\\(.)/g, "$1").replace(/["']/g, "");
}

// Разделители командных позиций: ; & | && || ( ) ` $( и перевод строки.
const SEGMENT_SPLIT = /[;&|()`\n]+/;

// Обёртки, после которых следующий токен — снова командная позиция: слово + его флаги
// и VAR=значение; у timeout дополнительно съедается длительность. bash/sh -c и node
// включены: после снятия кавычек `bash -c iva restart` исполняет ровно iva restart,
// а `node bin/iva.mjs restart` — тот же CLI напрямую.
const WRAPPER =
  /^(?:(?:sudo|command|exec|nohup|setsid|nice|node|env|(?:ba|da|z)?sh)(?:\s+(?:-\S+|\w+=\S*))*|timeout(?:\s+-\S+)*\s+\S+)\s+/;

function commandPositions(command: string): string[] {
  const out: string[] = [];
  for (const raw of normalize(command).split(SEGMENT_SPLIT)) {
    let seg = raw.trimStart();
    for (;;) {
      const m = WRAPPER.exec(seg);
      if (!m || !m[0].trim()) break;
      seg = seg.slice(m[0].length).trimStart();
    }
    if (seg) out.push(seg);
  }
  return out;
}

// Сам CLI: restart|stop|reset|full-reset останавливают iva.service; update перезапускает
// его в конце; doctor рестартует в ремонтных ветках (см. шапку). Ловим прямые вызовы
// файла (bin/iva.mjs restart, ./bin/iva.mjs) и форму с разделителем (npm-скрипты сюда
// не доходят — их снимает WRAPPER только у sh -c, а `npm run iva -- restart` ловится
// отдельной альтернативой).
const IVA_CLI_LETHAL =
  /^(?:(?:[\w./~-]*\/)?iva(?:\.mjs)?|npm\s+run\s+iva\s+--)\s+(?:--\s+)?(?:restart|stop|reset|full-reset|update|doctor)(?![\w-])/;

// systemctl с летальным глаголом, у которого среди юнитов-аргументов есть ровно "iva"
// или "iva.service" (iva-telegram-poll и таймеры не матчятся: после iva идёт дефис).
const SYSTEMCTL_LETHAL =
  /^systemctl\b(?:\s+[\w=@.:%-]+)*?\s+(?:restart|try-restart|reload-or-restart|stop|kill)\s+(?:[\w@.:%-]+\s+)*iva(?:\.service)?(?![\w-])/;

// pkill/killall по node/eve/iva кладут сам процесс eve-сервера (и мост заодно).
const PKILL_LETHAL = /^(?:pkill|killall)\b[^]*?\b(?:node|eve|iva)(?![\w-])/;

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
  for (const seg of commandPositions(command)) {
    for (const { re, what } of RULES) {
      if (re.test(seg)) {
        return (
          `ЗАБЛОКИРОВАНО: ${what}. Это убьёт процесс самой Ивы посреди текущего хода — ` +
          `ход навсегда зависнет в running, сервис уйдёт в цикл перезапусков, а бот замолчит ` +
          `с HookConflictError (issue #68). Перезапуск инициирует только пользователь: ` +
          `предложи ему /restart прямо в чате (для обновления — /update, диагностика — ` +
          `кнопка Doctor в /menu), либо \`iva restart\` / \`iva update\` в терминале.`
        );
      }
    }
  }
  return null;
}

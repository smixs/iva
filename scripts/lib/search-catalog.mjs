// Каталог веб-поисковых провайдеров для меню-визарда — зеркало scripts/lib/model-catalog.mjs,
// но без live-списка (у поиска нет «моделей»): только статичные факты провайдера + мягкая проба ключа.
// ИСТОЧНИК ПРАВДЫ по эндпойнтам/заголовкам/телу запроса — agent/tools/web_search.ts (массив PROVIDERS).
// Мост на .mjs не может импортировать TS-инструмент, поэтому факты авторизации продублированы здесь;
// при правке провайдера в web_search.ts эти билдеры надо синхронизировать вручную.
export const SEARCH_CATALOG = {
  tavily: { label: "Tavily", keyVar: "TAVILY_API_KEY", url: "https://app.tavily.com" },
  brave: { label: "Brave", keyVar: "BRAVE_API_KEY", url: "https://api-dashboard.search.brave.com" },
  exa: { label: "Exa", keyVar: "EXA_API_KEY", url: "https://dashboard.exa.ai" },
  parallel: { label: "Parallel", keyVar: "PARALLEL_API_KEY", url: "https://platform.parallel.ai" },
};

// Зависший эндпойнт провайдера не должен подвесить единственный getUpdates-цикл моста:
// проба на 1 результат укладывается в секунды, дольше 3с ждать нельзя (мост стоит).
const FETCH_TIMEOUT_MS = 3_000;

// Билдеры пробного запроса на 1 результат — калька build() из web_search.ts с n=1.
// Ключ уходит только в заголовок/тело fetch; наружу (лог/текст причины) он не попадает.
const PROBE = {
  tavily: (key) => ({
    url: "https://api.tavily.com/search",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: "ping", max_results: 1, search_depth: "basic", include_answer: "basic", topic: "general" }),
  }),
  brave: (key) => ({
    url: "https://api.search.brave.com/res/v1/web/search?q=ping&count=1",
    method: "GET",
    headers: { Accept: "application/json", "X-Subscription-Token": key },
  }),
  exa: (key) => ({
    url: "https://api.exa.ai/search",
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query: "ping", type: "auto", numResults: 1 }),
  }),
  parallel: (key) => ({
    url: "https://api.parallel.ai/v1/search",
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({ objective: "ping", search_queries: ["ping"], mode: "basic", advanced_settings: { max_results: 1 } }),
  }),
};

// Дешёвая проба валидности ключа (та же мягкая политика, что model-catalog.checkKey :92-107):
// 401/403 → отказ с короткой причиной, любой другой исход (иной статус, сетевой сбой, таймаут) → null.
// Сеть флакует чаще, чем ключи протухают, поэтому сомнение трактуем в пользу ключа — не блокируем юзера.
// Возвращает null, когда ключ выглядит рабочим, либо строку-причину.
export async function checkSearchKey(provider, key) {
  const build = PROBE[provider];
  if (!build) return null; // неизвестный провайдер — пробовать нечего, принимаем
  const req = build(key);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return `провайдер отверг ключ (${res.status})`;
    return null;
  } catch {
    return null; // сеть/таймаут — ключ не наказываем
  }
}

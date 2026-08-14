// Каждая нода графа владеет своим sandbox: authored-пин ищется как sandbox.<ext> рядом с
// agent.ts самой ноды, и корневой agent/sandbox.ts на субагентов НЕ распространяется. Без
// этого файла planner берёт рантайм-дефолт, а тот на Linux x64 считает microsandbox
// поддержанным и выбирает его — bash-тул падает с «requires the microsandbox package»
// (на macOS backend unsupported, дефолт тихо сваливался в just-bash, потому баг только на VPS).
// Пин переиспользуем корневой, чтобы backend у обеих нод не разъехался.
export { default } from "../../sandbox.js";

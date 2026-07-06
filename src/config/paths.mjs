import path from "node:path";

export function stripWindowsLongPathPrefix(value) {
  let text = String(value || "");
  if (process.platform === "win32") {
    text = text.replace(/^\\\\\?\\UNC\\/i, "\\\\");
    text = text.replace(/^\\\\\?\\/i, "");
  }
  return text;
}

export function sameResolvedPath(left, right) {
  const normalize = (value) => stripWindowsLongPathPrefix(path.resolve(String(value || "")));
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

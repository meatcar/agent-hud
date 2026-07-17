import colors from "./colors.ts";

import { pad2 } from "./helpers.ts";

export const buildVimPrefix = (vimMode: string | undefined): string => {
  if (vimMode === "NORMAL") {
    return `${colors.green("N")} `;
  }
  if (vimMode) {
    return `${colors.dim("I")} `;
  }
  return "";
};

export const formatTime = (date: Date): string =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

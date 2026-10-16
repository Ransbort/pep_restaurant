export const cn = (...c: Array<string | false | null | undefined | 0>) => c.filter(Boolean).join(" ")

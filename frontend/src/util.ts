/// Join truthy class names — a tiny clsx.
export const cx = (...xs: (string | false | undefined | null)[]) => xs.filter(Boolean).join(' ')

/// Middle-ellipsize a 0x hash, keeping the prefix and `n` chars on each side.
export const short = (h: string, n = 10) => h.slice(0, 2 + n) + '…' + h.slice(-n)

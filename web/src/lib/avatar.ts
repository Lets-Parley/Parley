/**
 * The avatar disc's diameter in px, by size name.
 *
 * Lives here rather than in `Avatar.tsx` so a caller that stacks something
 * under an avatar can reserve exactly this much room without importing a
 * constant out of a component module.
 *
 * A caller has to reserve it explicitly, because the chip cannot be trusted to
 * reserve its own. `Avatar` renders an `inline-flex` box of a fixed pixel
 * size, but a wrapper that lets that box sit on a line box takes its height
 * from the box's *baseline*, and the baseline moves with the box's contents:
 * with a portrait `<img>` flex item the baseline is the box's bottom edge, so
 * the line box adds the strut's descender below the whole disc, while with
 * text initials the baseline is the text baseline inside the disc and the
 * descender fits in space that already exists. Measured in Chrome that is 53px
 * against 46px — enough to knock a poker seat's card visibly out of line with
 * its neighbour's.
 */
export const avatarSizes = { xs: 24, sm: 28, md: 38, lg: 46 } as const;

export type AvatarSize = keyof typeof avatarSizes;

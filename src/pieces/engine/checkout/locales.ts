// Which ending of a resource bundle's file name is a locale: `_fr`, `_fr_FR`, the language one of
// ISO 639-1 (and the old Java codes `in`, `iw`, `ji`), the country two capitals. Any other ending
// belongs to the bundle's own name: `garden_ui` is a bundle, not `garden` in a language `ui`.
// Pure: no Node, no Orca.

/** ISO 639-1 language codes, and the three Java still reads as old forms of them. */
export const LANGUAGE_CODES: ReadonlySet<string> = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ' +
    'ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my ' +
    'na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ' +
    'ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu in iw ji'
  ).split(' ')
)

/** Whether a text is a locale a bundle's file name can end with: `fr`, `fr_FR`. */
export function isLocaleSuffix(text: string): boolean {
  const match = /^([a-z]{2})(?:_[A-Z]{2})?$/.exec(text)
  return match !== null && LANGUAGE_CODES.has(match[1])
}

/** A bundle file's name without its locale: `product` for `product_fr` and `product_fr_FR`; `garden_ui` stays whole. */
export function bundleBase(file: string): string {
  const match = /_([a-z]{2}(?:_[A-Z]{2})?)$/.exec(file)
  return match && isLocaleSuffix(match[1]) ? file.slice(0, match.index) : file
}

/** Whether a file is the bundle `name`, or `name` in a locale (`name_fr`, `name_fr_FR`). */
export function isBundleOf(file: string, name: string): boolean {
  return file === name || (file.startsWith(`${name}_`) && isLocaleSuffix(file.slice(name.length + 1)))
}

// A tiny element builder. Strings always become text nodes, never HTML.
type Child = Node | string | null | undefined | false;

type Props = {
  class?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
};

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  Object.entries(props.attrs ?? {}).forEach(([k, v]) => el.setAttribute(k, v));
  Object.entries(props.on ?? {}).forEach(([k, f]) => f && el.addEventListener(k, f));
  el.append(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
  return el;
};

export const clear = (el: Element, ...children: Node[]): void => el.replaceChildren(...children);

/**
 * Runs inside the page. Flattens a frame's DOM into the same `UiNode` shape a
 * desktop accessibility adapter would produce: role, accessible name, value,
 * table coordinates, bounds.
 *
 * The interesting work is name inference. On the screens this project targets,
 * a large share of inputs have no `id`, no `<label for>`, no `title` and no
 * ARIA — the only text identifying them sits in the table cell to their left,
 * or in the header cell above their column. Recovering that is what lets a
 * recorded artifact address "the field labelled Member Number" on a screen that
 * offers nothing else to address it by.
 *
 * This function is stringified and evaluated in the browser, so it must stay
 * self-contained: no imports, no closure over module scope.
 */

export interface RawNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  nearbyText?: string;
  enabled: boolean;
  editable: boolean;
  visible: boolean;
  text?: string;
  table?: {
    rowIndex: number;
    columnIndex: number;
    columnHeader?: string;
    rowHeader?: string;
  };
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface FrameExtract {
  nodes: RawNode[];
  text: string;
  title: string;
}

export const REF_ATTRIBUTE = 'data-rf-ref';

export function extractFrame(frameKey: string): FrameExtract {
  const REF_ATTR = 'data-rf-ref';
  const doc = document;

  const clean = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim();

  const stripLabelPunctuation = (value: string): string =>
    clean(value).replace(/[:*]\s*$/, '').trim();

  const isVisible = (el: Element): boolean => {
    // checkVisibility walks ancestors, which matters: an element inside a
    // display:none parent reports its own computed display unchanged, so
    // inspecting only the element's own style lets hidden controls through.
    const withCheck = el as Element & {
      checkVisibility?: (options?: Record<string, boolean>) => boolean;
    };
    if (typeof withCheck.checkVisibility === 'function') {
      return withCheck.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // A collapsed table cell is still real; treat anything with text as present.
      return clean(el.textContent).length > 0;
    }
    return true;
  };

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'form') return 'form';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
        return 'button';
      }
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'hidden') return null;
      return 'textbox';
    }
    return null;
  };

  const textOf = (el: Element): string => {
    // Table cells frequently wrap their content in <font>/<b>; textContent is
    // the right level for them. Inputs have no text.
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return '';
    return clean(el.textContent);
  };

  const accessibleName = (el: Element): string => {
    const ariaLabel = clean(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => clean(doc.getElementById(id)?.textContent))
        .filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return clean((el as HTMLInputElement).value);
      }
      if (type === 'image') return clean(el.getAttribute('alt'));
    }
    if (tag === 'img') return clean(el.getAttribute('alt'));

    const id = el.getAttribute('id');
    if (id) {
      const label = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) return stripLabelPunctuation(label.textContent ?? '');
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) return stripLabelPunctuation(wrappingLabel.textContent ?? '');

    const title = clean(el.getAttribute('title'));
    if (title) return title;

    if (tag === 'a' || tag === 'button' || tag === 'td' || tag === 'th' || /^h[1-6]$/.test(tag)) {
      return textOf(el);
    }
    return '';
  };

  /**
   * The fallback that makes unlabelled legacy forms addressable. Tries, in
   * order: the previous cell in the same row, the header cell above this
   * column, then the text immediately preceding the control in its parent.
   */
  const inferNearbyText = (el: Element): string => {
    const cell = el.closest('td, th');
    if (cell) {
      let sibling = cell.previousElementSibling;
      while (sibling) {
        const text = stripLabelPunctuation(sibling.textContent ?? '');
        if (text) return text;
        sibling = sibling.previousElementSibling;
      }
      const row = cell.closest('tr');
      const table = cell.closest('table') as HTMLTableElement | null;
      if (row && table && table.rows.length > 1 && table.rows[0] !== row) {
        const index = (cell as HTMLTableCellElement).cellIndex;
        const header = table.rows[0]?.cells[index];
        const text = stripLabelPunctuation(header?.textContent ?? '');
        if (text) return text;
      }
    }
    let node = el.previousSibling;
    while (node) {
      const text = stripLabelPunctuation(node.textContent ?? '');
      if (text) return text;
      node = node.previousSibling;
    }
    const parentText = stripLabelPunctuation(el.parentElement?.textContent ?? '');
    return parentText;
  };

  const tableContextOf = (el: Element): RawNode['table'] => {
    const cell = el.closest('td, th') as HTMLTableCellElement | null;
    if (!cell) return undefined;
    const row = cell.closest('tr') as HTMLTableRowElement | null;
    const table = cell.closest('table') as HTMLTableElement | null;
    if (!row || !table) return undefined;
    const rowIndex = Array.prototype.indexOf.call(table.rows, row);
    const columnIndex = cell.cellIndex;
    const headerRow = table.rows[0];
    const columnHeader =
      headerRow && headerRow !== row ? clean(headerRow.cells[columnIndex]?.textContent) : undefined;
    const rowHeader = clean(row.cells[0]?.textContent);
    return {
      rowIndex,
      columnIndex,
      columnHeader: columnHeader || undefined,
      rowHeader: rowHeader || undefined,
    };
  };

  const valueOf = (el: Element): string | undefined => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return input.checked ? 'checked' : 'unchecked';
      if (type === 'submit' || type === 'button' || type === 'reset') return undefined;
      return input.value;
    }
    if (tag === 'textarea') return (el as HTMLTextAreaElement).value;
    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      return select.options[select.selectedIndex]?.text ?? '';
    }
    return undefined;
  };

  const isEditable = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image';
  };

  // Clear refs from a previous observation so stale handles cannot resolve.
  doc.querySelectorAll(`[${REF_ATTR}]`).forEach((el) => el.removeAttribute(REF_ATTR));

  const nodes: RawNode[] = [];
  let counter = 0;
  const elements = doc.querySelectorAll(
    'a[href], button, input, select, textarea, td, th, h1, h2, h3, h4, h5, h6, [role]',
  );

  elements.forEach((el) => {
    const role = roleOf(el);
    if (role === null) return;
    if (!isVisible(el)) return;
    // Legacy screens nest tables for layout, so most <td>s are wrappers whose
    // text is every descendant's text concatenated. Only leaf cells carry a
    // value worth addressing.
    if ((role === 'cell' || role === 'columnheader') && el.querySelector('td, th') !== null) {
      return;
    }

    const ref = `${frameKey}::${counter++}`;
    el.setAttribute(REF_ATTR, ref);

    const name = accessibleName(el);
    const editable = isEditable(el);
    const rect = el.getBoundingClientRect();
    const node: RawNode = {
      ref,
      role,
      name,
      enabled: !(el as HTMLInputElement).disabled,
      editable,
      visible: true,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    const value = valueOf(el);
    if (value !== undefined) node.value = value;
    const text = textOf(el);
    if (text) node.text = text;
    // Only spend the inference on controls that need it.
    if (name === '' && (editable || role === 'checkbox' || role === 'radio')) {
      const nearby = inferNearbyText(el);
      if (nearby) node.nearbyText = nearby;
    }
    const table = tableContextOf(el);
    if (table) node.table = table;
    nodes.push(node);
  });

  return {
    nodes,
    text: clean(doc.body?.innerText ?? doc.body?.textContent ?? ''),
    title: clean(doc.title),
  };
}

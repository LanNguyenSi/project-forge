/**
 * Patches one swagger-ui server picker so the selected URL stays readable:
 * - the select keeps the accessible name swagger-ui leaves out (existing ones
 *   are preserved);
 * - its `title` carries the full text of the currently selected option, as a
 *   supplement for pointer users (tooltip) and assistive tech; at phone widths
 *   the select itself wraps the option text (swagger-ui sets `appearance: none`
 *   and `app/globals.css` sets `white-space: normal`, so the control grows to
 *   two lines instead of cutting the URL mid-word);
 * - a `change` listener keeps the title in sync with the selection, attached
 *   once per element (guarded by a data attribute) so repeated MutationObserver
 *   callbacks do not stack listeners on the same select.
 */
export function patchServerSelect(select: HTMLSelectElement): void {
  if (!select.hasAttribute("aria-label")) select.setAttribute("aria-label", "API server");

  const syncTitle = () => {
    const option = select.options[select.selectedIndex];
    select.setAttribute("title", option?.textContent ?? "");
  };
  syncTitle();

  if (!select.dataset.serverTitleBound) {
    select.dataset.serverTitleBound = "1";
    select.addEventListener("change", syncTitle);
  }
}

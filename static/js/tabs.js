/* =====================================================================
   MarkItDown Toolbox — Tab switching
   ===================================================================== */

(() => {
    "use strict";

    const buttons = document.querySelectorAll(".tab-btn");
    const panels = document.querySelectorAll(".tab-panel");

    buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
            buttons.forEach((b) => {
                const active = b === btn;
                b.classList.toggle("tab-btn--active", active);
                b.setAttribute("aria-selected", String(active));
            });
            panels.forEach((panel) => {
                const active = panel.id === `tab-${btn.dataset.tab}`;
                panel.classList.toggle("tab-panel--active", active);
                panel.hidden = !active;
            });
        });
    });
})();

// Import order matters: fonts and tokens first, then the cascade from
// generic (base) to specific (sections). See marketing-site/README.md.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/sections.css";

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Reveal animations are entirely opt-in via this class. If this script never
// runs, [data-reveal] elements stay at their natural opacity/position — the
// page is fully readable with JavaScript disabled.
document.documentElement.classList.add("js");

// --- Footer year --------------------------------------------------------

const yearEl = document.querySelector("[data-year]");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// --- Header scrolled state (IntersectionObserver, never a scroll listener) ---

const header = document.querySelector("[data-header]");
const headerSentinel = document.querySelector("[data-header-sentinel]");

if (header && headerSentinel && "IntersectionObserver" in window) {
  const headerObserver = new IntersectionObserver(
    ([entry]) => {
      header.classList.toggle("is-scrolled", !entry.isIntersecting);
    },
    { threshold: 0 },
  );
  headerObserver.observe(headerSentinel);
}

// --- Scroll reveals (IntersectionObserver, disabled under reduced motion) ---

const revealTargets = document.querySelectorAll("[data-reveal]");

if (prefersReducedMotion.matches) {
  revealTargets.forEach((el) => el.classList.add("is-revealed"));
} else if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
  );
  revealTargets.forEach((el) => revealObserver.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add("is-revealed"));
}

// --- Mobile nav overlay: dialog semantics, Escape, focus trap, body lock,
//     inert background, and internal-anchor focus handoff -----------------

const navToggle = document.querySelector("[data-nav-toggle]");
const navOverlay = document.querySelector("[data-nav-overlay]");

if (navToggle && navOverlay) {
  let lastFocused = null;
  let isOpen = false;

  const focusableSelector = "a[href], button:not([disabled])";
  const getFocusable = () => Array.from(navOverlay.querySelectorAll(focusableSelector));

  // While the overlay is open, everything behind it must be unreachable to
  // assistive tech and the keyboard — except the header's own close toggle,
  // which stays operable so the pill nav keeps working as the close control.
  const backgroundInertSelectors = [
    "#main",
    ".site-footer",
    ".site-header .brand",
    ".site-header .site-nav",
    ".site-header .site-header__cta",
  ];

  const setBackgroundInert = (state) => {
    backgroundInertSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (state) {
          el.setAttribute("inert", "");
        } else {
          el.removeAttribute("inert");
        }
      });
    });
  };

  const openNav = () => {
    if (isOpen) return;
    isOpen = true;
    lastFocused = document.activeElement;
    navOverlay.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
    navToggle.setAttribute("aria-label", "Close menu");
    document.body.style.overflow = "hidden";
    setBackgroundInert(true);

    // Force a reflow so the opening transition runs from the hidden state.
    void navOverlay.offsetHeight;
    navOverlay.classList.add("is-open");

    const focusables = getFocusable();
    (focusables[0] ?? navOverlay).focus();
  };

  // `restoreFocus` is skipped when a click is about to hand focus off to an
  // in-page target instead (see the internal-link handler below).
  // `onClosed` runs once the closing transition has actually finished (or
  // immediately under reduced motion) so scroll/focus handoffs never race
  // the overlay's own opacity/transform transition.
  const closeNav = ({ restoreFocus = true, onClosed } = {}) => {
    if (!isOpen) return;
    isOpen = false;
    navOverlay.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open menu");
    document.body.style.overflow = "";
    setBackgroundInert(false);

    const finish = () => {
      navOverlay.hidden = true;
      if (restoreFocus) (lastFocused ?? navToggle).focus();
      onClosed?.();
    };

    if (prefersReducedMotion.matches) {
      finish();
    } else {
      navOverlay.addEventListener("transitionend", finish, { once: true });
    }
  };

  navToggle.addEventListener("click", () => (isOpen ? closeNav() : openNav()));

  navOverlay.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") || "";

    if (href.startsWith("#")) {
      // In-page destination: close without returning focus to the hamburger,
      // then move focus to the target itself once the overlay has closed.
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const target = document.querySelector(href);

        closeNav({
          restoreFocus: false,
          onClosed: () => {
            if (!target) return;
            target.scrollIntoView({
              behavior: prefersReducedMotion.matches ? "auto" : "smooth",
              block: "start",
            });
            target.focus({ preventScroll: true });
            history.replaceState(null, "", href);
          },
        });
      });
    } else {
      // External destination: default browser navigation still happens;
      // restoring focus to the trigger on close is the expected behavior.
      link.addEventListener("click", () => closeNav());
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!isOpen) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeNav();
      return;
    }

    if (event.key !== "Tab") return;

    const focusables = getFocusable();
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

// --- Windows SmartScreen info dialog: role=dialog, Escape, backdrop click,
//     focus trap, body lock, inert background, focus restoration ---------
//
// This mirrors the mobile nav overlay's proven open/close/trap pattern above
// rather than extracting a shared helper, so the already-working nav logic
// stays untouched. The one real difference: this is a true top-level modal,
// so *everything* else — including the floating header — goes inert while
// it's open, instead of carving out an exception for a close control.

const windowsToggle = document.querySelector("[data-windows-open]");
const windowsBackdrop = document.querySelector("[data-windows-modal]");
const windowsDialog = windowsBackdrop?.querySelector("[role='dialog']");
const windowsCloseButtons = windowsBackdrop?.querySelectorAll("[data-windows-close]");

if (windowsToggle && windowsBackdrop && windowsDialog) {
  let modalLastFocused = null;
  let modalOpen = false;

  const modalFocusableSelector = "a[href], button:not([disabled])";
  const getModalFocusable = () => Array.from(windowsDialog.querySelectorAll(modalFocusableSelector));

  const modalInertSelectors = ["#main", ".site-footer", ".site-header", ".nav-overlay"];

  const setModalBackgroundInert = (state) => {
    modalInertSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (state) {
          el.setAttribute("inert", "");
        } else {
          el.removeAttribute("inert");
        }
      });
    });
  };

  const openModal = () => {
    if (modalOpen) return;
    modalOpen = true;
    modalLastFocused = document.activeElement;
    windowsBackdrop.hidden = false;
    document.body.style.overflow = "hidden";
    setModalBackgroundInert(true);

    // Force a reflow so the opening transition runs from the hidden state.
    void windowsBackdrop.offsetHeight;
    windowsBackdrop.classList.add("is-open");

    const focusables = getModalFocusable();
    (focusables[0] ?? windowsDialog).focus();
  };

  const closeModal = () => {
    if (!modalOpen) return;
    modalOpen = false;
    windowsBackdrop.classList.remove("is-open");
    document.body.style.overflow = "";
    setModalBackgroundInert(false);

    const finish = () => {
      windowsBackdrop.hidden = true;
      (modalLastFocused ?? windowsToggle).focus();
    };

    if (prefersReducedMotion.matches) {
      finish();
    } else {
      windowsBackdrop.addEventListener("transitionend", finish, { once: true });
    }
  };

  windowsToggle.addEventListener("click", openModal);
  windowsCloseButtons?.forEach((button) => button.addEventListener("click", closeModal));

  windowsBackdrop.addEventListener("click", (event) => {
    if (event.target === windowsBackdrop) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (!modalOpen) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }

    if (event.key !== "Tab") return;

    const focusables = getModalFocusable();
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

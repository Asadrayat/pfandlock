// Positions the deposit notice rendered by deposit-notice-embed.liquid.
//
// An app embed can't be dropped inline in a theme's layout - Shopify always
// injects its markup right before </body>, regardless of what page element
// it's conceptually "about". This moves the already-rendered <p> next to a
// buy button if the theme's markup looks like one of a few common patterns;
// if none match, it's left in place and styled as a fixed bottom banner
// instead (see deposit-notice-embed.css) - an imprecise but visible notice
// beats a silently hidden one.
(function () {
  function place() {
    var notice = document.getElementById("pfandlock-deposit-embed");
    if (!notice) return;

    var addToCartForm = document.querySelector(
      'form[action*="/cart/add"]',
    );
    var anchor =
      addToCartForm &&
      (addToCartForm.querySelector('[type="submit"]') ||
        addToCartForm.querySelector(".product-form__submit") ||
        addToCartForm.querySelector(".product-form__buttons"));

    if (anchor && anchor.parentNode) {
      notice.classList.add("pfandlock-deposit-embed--inline");
      anchor.parentNode.insertBefore(notice, anchor);
    } else {
      notice.classList.add("pfandlock-deposit-embed--banner");
      document.body.appendChild(notice);
    }

    notice.hidden = false;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", place);
  } else {
    place();
  }
})();

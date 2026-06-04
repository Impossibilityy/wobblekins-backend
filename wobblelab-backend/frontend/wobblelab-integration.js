/* =====================================================================
   WOBBLELAB — Frontend integration  (Phase 4)
   ---------------------------------------------------------------------
   Connects your existing custom Wobblekin widget to the Vercel API using
   fetch(). No page redirect. Shows loading text, a styled success message
   with the request id, and a friendly error message.

   HOW TO USE on Hostinger:
     Paste this <script> block into the SAME custom HTML/embed area,
     directly AFTER the widget markup (after the closing </div> of
     #wobblekins-request-builder).

   It targets the widget's real elements:
     - form         #wk-contact-form
     - submit btn   #wk-submit-btn
     - status area  #wk-form-msg
     - file input   #wk-file-input  (name="reference_images")
     - text fields  #wk-name, #wk-email, #wk-phone, #wk-prefname,
                    #wk-use, #wk-notes, #wk-request
     - traits       read live from the widget via window... _wkGetSubmission()

   If your markup uses the generic ids from the spec instead
   (#wobblekinRequestForm / #sendWobblekinRequest / #wobblekinRequestStatus),
   just change the SELECTORS in CONFIG below.
   ===================================================================== */
(function () {
  "use strict";

  // ---- [EDIT] CONFIG --------------------------------------------------
  var CONFIG = {
    // Your deployed Vercel endpoint:
    endpoint: "https://YOUR-PROJECT.vercel.app/api/submit-request",

    // Element selectors (defaults match the Wobblekin widget):
    form:       "#wk-contact-form",
    submitBtn:  "#wk-submit-btn",
    status:     "#wk-form-msg",
    fileInput:  "#wk-file-input",

    // Map of {backendFieldName: cssSelector} for the text fields:
    fields: {
      name:                     "#wk-name",
      email:                    "#wk-email",
      phone:                    "#wk-phone",
      preferred_wobblekin_name: "#wk-prefname",
      intended_use:             "#wk-use",
      message:                  "#wk-notes",
      full_request:             "#wk-request"
    },

    loadingText: "Sending to the Wobble Lab…",
    successText: function (id) {
      return "Your Wobblekin request has entered the Wobble Lab! Request ID: " + id;
    },
    errorText: "Hmm, something went wrong sending your request. Please try again, or email us directly."
  };
  // --------------------------------------------------------------------

  function $(sel) { return document.querySelector(sel); }
  function val(sel) { var el = $(sel); return el ? (el.value || "").trim() : ""; }

  function setStatus(msg, kind) {
    var el = $(CONFIG.status);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("is-ok");
    if (kind === "ok") el.classList.add("is-ok");
  }

  function getTraits() {
    // Preferred: read the live structured selections the widget exposes.
    var root = document.getElementById("wobblekins-request-builder");
    if (root && typeof root._wkGetSubmission === "function") {
      try { return root._wkGetSubmission().traits || {}; } catch (e) {}
    }
    // Fallback: read the persisted draft from localStorage.
    try {
      var saved = JSON.parse(localStorage.getItem("wobblekinsRequestBuilder_v1") || "{}");
      return saved.sel || {};
    } catch (e) { return {}; }
  }

  function getFiles() {
    // Files are mirrored into the native input by the widget, so this works.
    var input = $(CONFIG.fileInput);
    if (input && input.files && input.files.length) {
      return Array.prototype.slice.call(input.files);
    }
    // Fallback to the exposed File objects.
    var root = document.getElementById("wobblekins-request-builder");
    if (root && typeof root._wkGetSubmission === "function") {
      try { return root._wkGetSubmission().files || []; } catch (e) {}
    }
    return [];
  }

  async function submit() {
    var btn = $(CONFIG.submitBtn);

    // 1. Client-side required check (server re-validates anyway).
    var name = val(CONFIG.fields.name);
    var email = val(CONFIG.fields.email);
    if (!name || !email) {
      setStatus("Please add your name and email so we can reach you.", "err");
      return;
    }

    // 2. Build multipart payload.
    var fd = new FormData();
    Object.keys(CONFIG.fields).forEach(function (backendKey) {
      fd.append(backendKey, val(CONFIG.fields[backendKey]));
    });
    fd.append("selected_traits", JSON.stringify(getTraits()));
    getFiles().forEach(function (file) { fd.append("reference_images", file); });

    // 3. Loading state.
    var original = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = CONFIG.loadingText; }
    setStatus(CONFIG.loadingText, "");

    // 4. Send. (Do NOT set Content-Type — the browser adds the multipart
    //    boundary automatically.)
    try {
      var resp = await fetch(CONFIG.endpoint, { method: "POST", body: fd });
      var data = await resp.json().catch(function () { return {}; });

      if (resp.ok && data.ok) {
        setStatus(CONFIG.successText(data.request_number), "ok");
        if (btn) btn.textContent = "Request sent ✓";
        // Clear the saved draft so a later refresh starts clean.
        try { localStorage.removeItem("wobblekinsRequestBuilder_v1"); } catch (e) {}
      } else {
        setStatus(data.error || CONFIG.errorText, "err");
        if (btn) { btn.disabled = false; btn.textContent = original; }
      }
    } catch (err) {
      setStatus(CONFIG.errorText, "err");
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  // ---- Wire up --------------------------------------------------------
  // Intercept the form's submit in the CAPTURE phase so this fetch flow
  // fully replaces the widget's built-in (no-endpoint) fallback handler,
  // and prevents any native navigation/redirect.
  document.addEventListener(
    "submit",
    function (e) {
      var form = $(CONFIG.form);
      if (!form || e.target !== form) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      submit();
    },
    true
  );

  // Also handle a plain (type="button") submit button if present.
  document.addEventListener("click", function (e) {
    var btn = $(CONFIG.submitBtn);
    if (btn && e.target === btn && btn.type !== "submit") {
      e.preventDefault();
      submit();
    }
  });
})();

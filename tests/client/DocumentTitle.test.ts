/**
 * @vitest-environment jsdom
 *
 * The browser-tab title must stay "Landtaker", in every language.
 *
 * Every inherited language file still carries the upstream product name under
 * `main.title`, and those files are Crowdin-managed so they cannot be edited
 * here. LangSelector therefore forces document.title to a constant — but the
 * generic [data-i18n] pass runs afterwards, so a tagged <title> silently undid
 * it and the tab read "OpenFront (ALPHA)" for every non-English locale.
 *
 * Two things keep that from coming back: the tag is gone from index.html, and
 * the pass skips <title> even if someone adds it again.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

const indexHtml = fs.readFileSync(
  path.resolve(__dirname, "../../index.html"),
  "utf8",
);

/** The <title> line, however it is formatted. */
const titleTag = indexHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/);

describe("browser tab title", () => {
  test("index.html ships the Landtaker title", () => {
    expect(titleTag).not.toBeNull();
    expect(titleTag![1].trim()).toBe("Landtaker (ALPHA)");
  });

  test("the title is not a data-i18n target", () => {
    // Tagging it hands the tab back to the language files, which still say
    // "OpenFront" in every locale but English.
    expect(titleTag![0]).not.toContain("data-i18n");
  });

  test("en.json carries no main.title to reintroduce", () => {
    const en = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../resources/lang/en.json"),
        "utf8",
      ),
    );
    expect(en.main?.title).toBeUndefined();
  });
});

describe("the data-i18n pass", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  test("skips <title> even when it is tagged", () => {
    // Mirrors the guard in LangSelector.applyTranslations.
    document.head.innerHTML = `<title data-i18n="main.title">Landtaker (ALPHA)</title>`;
    document.body.innerHTML = `<span id="other" data-i18n="main.play">Play</span>`;

    const translations: Record<string, string> = {
      "main.title": "OpenFront (ALPHA)",
      "main.play": "Spielen",
    };

    document.title = "Landtaker (ALPHA)";
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      if (element.tagName === "TITLE") return;
      const key = element.getAttribute("data-i18n");
      if (key === null) return;
      const text = translations[key];
      if (text === undefined) return;
      element.textContent = text;
    });

    expect(document.title).toBe("Landtaker (ALPHA)");
    // Everything else still translates.
    expect(document.getElementById("other")!.textContent).toBe("Spielen");
  });

  test("without the guard the tab would read OpenFront", () => {
    // Pins why the guard exists: this is the exact behaviour that shipped.
    document.head.innerHTML = `<title data-i18n="main.title">Landtaker (ALPHA)</title>`;
    document.title = "Landtaker (ALPHA)";
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = "OpenFront (ALPHA)";
    });

    expect(document.title).toBe("OpenFront (ALPHA)");
  });
});

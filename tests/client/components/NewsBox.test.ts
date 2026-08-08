import newsItems from "../../../resources/news.json";
import {
  getVisibleNewsItems,
  NewsItem,
} from "../../../src/client/components/NewsBox";

const DISMISSED_NEWS_KEY = "dismissedNewsItems";
const allItems = newsItems as NewsItem[];

function createMockLocalStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

describe("NewsBox", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createMockLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getVisibleNewsItems", () => {
    it("returns all items when none are dismissed", () => {
      const items = getVisibleNewsItems(allItems);
      expect(items.length).toBe(newsItems.length);
    });

    it("filters out dismissed items", () => {
      const items = getVisibleNewsItems(allItems);
      const firstId = items[0].id;
      localStorage.setItem(DISMISSED_NEWS_KEY, JSON.stringify([firstId]));
      const filtered = getVisibleNewsItems(allItems);
      expect(filtered.find((i) => i.id === firstId)).toBeUndefined();
      expect(filtered.length).toBe(items.length - 1);
    });

    it("returns empty when all items are dismissed", () => {
      const allIds = allItems.map((i) => i.id);
      localStorage.setItem(DISMISSED_NEWS_KEY, JSON.stringify(allIds));
      const items = getVisibleNewsItems(allItems);
      expect(items.length).toBe(0);
    });
  });

  describe("news items structure", () => {
    it("each item has required fields", () => {
      const items = getVisibleNewsItems(allItems);
      for (const item of items) {
        expect(item.id).toBeDefined();
        expect(typeof item.id).toBe("string");
        expect(item.title).toBeDefined();
        expect(typeof item.title).toBe("string");
        const hasDescription =
          item.description !== undefined ||
          item.descriptionTranslationKey !== undefined;
        expect(hasDescription).toBe(true);
        expect(item.type).toBeDefined();
        expect(["tournament", "tutorial", "announcement", "warning"]).toContain(
          item.type,
        );
      }
    });

    it("each item has a unique id", () => {
      const items = getVisibleNewsItems(allItems);
      const ids = items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("has at least one item to show", () => {
      // The box renders nothing at all when the feed is empty, so an accidental
      // clear-out would silently remove it from the home page.
      expect(getVisibleNewsItems(allItems).length).toBeGreaterThan(0);
    });

    it("only uses types the box knows how to label", () => {
      // An unknown type falls through typeLabelColors and renders an unstyled
      // chip, so the feed must stay within the set NewsBox styles.
      const items = getVisibleNewsItems(allItems);
      for (const item of items) {
        expect(["tournament", "tutorial", "announcement", "warning"]).toContain(
          item.type,
        );
      }
    });

    it("links out over https only, never a bare or scriptable URL", () => {
      // These go straight into href; a javascript: or http: entry would be a
      // real hole, and the schema only guards the API-served feed.
      for (const item of getVisibleNewsItems(allItems)) {
        if (item.url === null || item.url === undefined) continue;
        expect(item.url.startsWith("https://")).toBe(true);
      }
    });
  });
});

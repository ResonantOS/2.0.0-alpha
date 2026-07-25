export const DEFAULT_TITLE = "Example Page";
export const DEFAULT_URL = "https://example.com/article";

export function articleSnapshot(overrides = {}) {
  return {
    title: "The Art of Resonant Context",
    url: "https://example.com/article/resonant-context",
    domain: "example.com",
    summary: "A demonstration article for Augmentor context fixtures.",
    text: [
      "ResonantOS is a browser-first operating system.",
      "It combines an authenticated local bridge with a Chrome side panel.",
      "Augmentor reads the active page and answers questions using bounded context.",
      ...Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1}: ${"word ".repeat(20).trim()}.`)
    ].join("\n\n"),
    page: {
      headings: ["Introduction", "Browser-first design", "Augmentor", "Conclusion"]
    },
    viewport: {
      visibleSections: [
        { id: "intro", label: "Introduction", text: "ResonantOS is a browser-first operating system.", currentlyVisible: true, priority: 8 },
        { id: "design", label: "Browser-first design", text: "It combines an authenticated local bridge with a Chrome side panel.", currentlyVisible: true, priority: 7 }
      ],
      activeOverlay: null
    },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function pdfSnapshot(overrides = {}) {
  return {
    title: "Annual Report 2026",
    url: "https://example.com/reports/annual.pdf",
    domain: "example.com",
    summary: "",
    text: "",
    skipReason: "PDF viewer — text extraction is not available.",
    page: { headings: [] },
    viewport: { visibleSections: [], activeOverlay: null },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function mediaSnapshot(overrides = {}) {
  return {
    title: "Keynote Livestream",
    url: "https://example.com/watch?v=keynote2026",
    domain: "example.com",
    summary: "",
    text: "",
    skipReason: "Media player — no readable transcript available.",
    page: { headings: [] },
    viewport: { visibleSections: [], activeOverlay: null },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function mixedMediaPageSnapshot(overrides = {}) {
  return {
    title: "Article with Embedded Video",
    url: "https://example.com/article/embedded-video",
    domain: "example.com",
    summary: "An article that contains a video but still has readable surrounding text.",
    text: "This article explains a concept. Below is an embedded player. The remaining paragraphs are readable.",
    page: { headings: ["Overview", "Demo video", "Takeaways"] },
    viewport: {
      visibleSections: [
        { id: "overview", label: "Overview", text: "This article explains a concept.", currentlyVisible: true, priority: 8 },
        { id: "video", label: "Demo video", text: "", currentlyVisible: true, priority: 5 },
        { id: "takeaways", label: "Takeaways", text: "The remaining paragraphs are readable.", currentlyVisible: true, priority: 6 }
      ],
      activeOverlay: null
    },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function secretLadenSnapshot(overrides = {}) {
  return {
    title: "PDF with token in title sk-live-ABCDEFGHIJKLMNOP",
    url: "https://example.com/reports/secret.pdf?token=sk-ant-ABCDEFGHIJKLMNOP#card=1234-5678-9012-3456",
    domain: "example.com",
    summary: "",
    text: "",
    skipReason: "PDF viewer — text extraction is not available.",
    page: { headings: [] },
    viewport: { visibleSections: [], activeOverlay: null },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

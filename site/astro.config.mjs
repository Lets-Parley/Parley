// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { mdastVersion } from "./src/mdast-version.mjs";

const description =
  "Planning poker and daily standups for your team, at your table. " +
  "Self-hosted, open source, one Go binary and a Postgres database.";

export default defineConfig({
  site: "https://www.letsparley.io",
  integrations: [
    // Substitutes %VERSION% in page content. Pushed onto Astro's own markdown
    // processor rather than constructing one: astro and starlight resolve
    // different @astrojs/markdown-satteri copies, and a processor built from
    // the wrong one fails Starlight's isSatteriProcessor check.
    {
      name: "parley-version",
      hooks: {
        "astro:config:setup": ({ config }) => {
          config.markdown.processor.options.mdastPlugins.push(mdastVersion());
        },
      },
    },
    starlight({
      title: "Parley",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      description,
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://www.letsparley.io/og.png" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Parley — planning poker and daily standups, self-hosted" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://www.letsparley.io/og.png" } },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/lets-parley/parley" },
      ],
      editLink: {
        baseUrl: "https://github.com/lets-parley/parley/edit/main/site/",
      },
      components: {
        Hero: "./src/components/Hero.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      customCss: ["./src/styles/parley.css"],
      // These pages run long and reference-heavy; the right-hand TOC is the
      // real navigation on them, so it needs H3.
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        { label: "Quickstart", link: "/quickstart/" },
        {
          label: "Features",
          items: [
            { slug: "features", label: "Overview" },
            "features/planning-poker",
            "features/daily-standup",
            "features/spaces-and-room-codes",
            "features/exports",
            "features/themes",
          ],
        },
        {
          label: "Operations",
          items: [
            { slug: "operations", label: "Overview" },
            "operations/architecture",
            "operations/deployment",
            "operations/single-server",
            "operations/kubernetes",
            "operations/reverse-proxy",
            "operations/observability",
            "operations/scaling-and-limits",
            "operations/backups-and-recovery",
            "operations/upgrading",
            "operations/runbook",
          ],
        },
        {
          label: "Security",
          items: [
            { slug: "security", label: "Overview" },
            // Titled "What a room code protects" rather than "Security model":
            // next to the group's own Overview and Threat model, a third
            // similar-sounding entry gave a reviewer no way to pick.
            "security/overview",
            "security/threat-model",
            "security/authentication",
            "security/authorization",
            "security/data-and-privacy",
            "security/hardening-checklist",
            "security/supply-chain",
            "security/review-pack",
          ],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { slug: "reference", label: "Overview" },
            "reference/configuration",
            "reference/api",
            "reference/database-schema",
            "reference/csv-format",
            "reference/limits-and-defaults",
          ],
        },
        { label: "Known limitations", link: "/known-limitations/" },
        {
          label: "Project",
          collapsed: true,
          items: ["project/roadmap", "project/releases", "project/contributing", "project/contrast"],
        },
      ],
    }),
  ],
});

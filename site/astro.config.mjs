// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";
import { mdastVersion } from "./src/mdast-version.mjs";
import { DESCRIPTION } from "./src/description.mjs";

const description = DESCRIPTION;

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
          const plugins = config.markdown.processor?.options?.mdastPlugins;
          if (!Array.isArray(plugins)) {
            throw new Error(
              "parley-version: the markdown processor has no mdastPlugins. " +
                "This needs Astro's default satteri() processor; unified() " +
                "takes remarkPlugins instead.",
            );
          }
          plugins.push(mdastVersion());
        },
      },
    },
    starlight({
      title: "Parley",
      plugins: [
        starlightLlmsTxt({
          details:
            "Parley is open source (MIT), one Go binary plus Postgres, run by the team that uses it; there is no hosted service. " +
            "Planning poker, daily standup and kudos are built in. The retrospective is a WebAssembly plugin: it is not in the image " +
            "or chart, and an operator builds it and installs it into PLUGIN_DIR. There is no public plugin registry and no " +
            "signature verification. Open mode (the default) asks only for a name; OIDC mode signs people in through an " +
            "identity provider; a guest link admits whoever opens it to one room only, up to 25 redemptions, for 24 hours, never as facilitator. Organizations are flat: no nested " +
            "or parent/child orgs. The Google Meet add-on is deployed by the operator in their own Workspace and needs https.",
          promote: ["index*", "quickstart*", "features/**", "known-limitations*"],
        }),
      ],
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      description,
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://www.letsparley.io/og.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Parley — self-hosted planning poker, standups and retros" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://www.letsparley.io/og.png" } },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/lets-parley/parley" },
      ],
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
            "features/async-standup-guide",
            "features/retrospective",
            "features/spaces-and-room-codes",
            "features/guest-links",
            "features/presenting-a-room",
            "features/kudos",
            "features/exports",
            "features/themes",
          ],
        },
        {
          label: "Operations",
          items: [
            { slug: "operations", label: "Overview" },
            "operations/architecture",
            "operations/organizations",
            "operations/deployment",
            "operations/single-server",
            "operations/kubernetes",
            "operations/gitops",
            "operations/reverse-proxy",
            "operations/observability",
            "operations/scaling-and-limits",
            "operations/backups-and-recovery",
            "operations/upgrading",
            "operations/air-gapped",
            "operations/google-meet",
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
            "security/organizations",
            "security/data-and-privacy",
            "security/plugin-sandbox",
            "security/hardening-checklist",
            "security/cryptography",
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
            "reference/build-your-first-plugin",
            "reference/plugin-sdk",
            "reference/plugin-protocol",
            "reference/plugin-bundle",
          ],
        },
        { label: "Known limitations", link: "/known-limitations/" },
        { label: "Parley compared", link: "/compare/" },
        {
          label: "Project",
          collapsed: true,
          items: ["project/roadmap", "project/releases", "project/contributing", "project/contrast"],
        },
      ],
    }),
  ],
});

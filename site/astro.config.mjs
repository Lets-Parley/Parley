// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://www.letsparley.io",
  integrations: [
    starlight({
      title: "Parley",
      description:
        "Planning poker and daily standups for your team, at your table. Self-hosted, open source.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/lets-parley/parley" },
      ],
      editLink: {
        baseUrl: "https://github.com/lets-parley/parley/edit/main/site/",
      },
      customCss: ["./src/styles/parley.css"],
      sidebar: [
        {
          label: "Get started",
          items: ["guides/quickstart", "guides/configuration"],
        },
        {
          label: "Running it",
          items: [
            "guides/sign-in",
            "guides/security",
            "guides/reverse-proxy",
            "guides/kubernetes",
            "guides/backups",
            "guides/upgrading",
          ],
        },
        {
          label: "Help",
          items: ["guides/troubleshooting", "guides/development"],
        },
      ],
    }),
  ],
});

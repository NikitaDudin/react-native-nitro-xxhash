const { themes } = require('prism-react-renderer');

const repository = 'https://github.com/NikitaDudin/react-native-nitro-xxhash';

module.exports = {
  title: 'Nitro xxHash',
  tagline: 'Strings, bytes and files. One native hashing API.',
  favicon: 'img/favicon.svg',
  url: 'https://NikitaDudin.github.io',
  baseUrl: '/react-native-nitro-xxhash/',
  organizationName: 'NikitaDudin',
  projectName: 'react-native-nitro-xxhash',
  trailingSlash: true,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: 'filename',
        language: 'en',
        docsDir: '../docs',
        docsRouteBasePath: '/',
        indexBlog: false,
        indexPages: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.cjs',
          editUrl: `${repository}/edit/main/docs/`,
          showLastUpdateAuthor: false,
          showLastUpdateTime: false,
        },
        blog: false,
        pages: false,
        theme: { customCss: './src/css/custom.css' },
      },
    ],
  ],
  themeConfig: {
    image: 'img/favicon.svg',
    colorMode: { defaultMode: 'light', respectPrefersColorScheme: true },
    navbar: {
      title: 'Nitro xxHash',
      logo: { alt: 'Nitro xxHash', src: 'img/favicon.svg', width: 30, height: 30 },
      items: [
        { type: 'doc', docId: 'installation', label: 'Get started', position: 'left' },
        { type: 'doc', docId: 'api/one-shot', label: 'API', position: 'left' },
        { href: repository, label: 'GitHub', position: 'right' },
      ],
    },
    docs: { sidebar: { hideable: true, autoCollapseCategories: false } },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Documentation',
          items: [
            { label: 'Installation', to: '/installation' },
            { label: 'API reference', to: '/api/one-shot' },
            { label: 'Compatibility', to: '/compatibility' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'Contributing', to: '/contributing' },
            { label: 'GitHub', href: repository },
            { label: 'Report an issue', href: `${repository}/issues` },
          ],
        },
      ],
      copyright: 'MIT licensed. Maintained by Nikita Dudin. Built with Docusaurus.',
    },
    prism: {
      theme: themes.github,
      darkTheme: themes.dracula,
      additionalLanguages: ['bash', 'ruby', 'java', 'cpp', 'json', 'diff'],
    },
    tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
  },
};

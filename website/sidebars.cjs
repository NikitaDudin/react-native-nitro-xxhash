module.exports = {
  documentation: [
    'intro',
    'installation',
    'expo',
    {
      type: 'category',
      label: 'API reference',
      collapsed: false,
      items: [
        'api/exports',
        'api/one-shot',
        'api/create-hasher',
        'api/inputs-and-outputs',
        'api/types',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsed: false,
      items: [
        'guides/files',
        'guides/streams',
        'guides/bundled-assets',
        'guides/errors-and-cancellation',
      ],
    },
    'compatibility',
    'contributing',
  ],
};

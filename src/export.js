export function exportObjectKey({ documentId, versionId, exportId }) {
  return `documents/${documentId}/versions/${versionId}/exports/${exportId}.png`;
}

export function stylePreviewObjectKey({ templateId }) {
  return `style-templates/${templateId}/preview.png`;
}

export async function renderHtmlToPng(browser, html, viewport = { width: 1080, height: 1440 }) {
  const response = await browser.quickAction('screenshot', {
    html,
    screenshotOptions: {
      fullPage: true,
      type: 'png'
    },
    viewport: { ...viewport, deviceScaleFactor: 1 }
  });

  if (!response.ok) throw new Error('render_failed');
  return response.body;
}

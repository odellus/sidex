Change this in [markdownRenderer.ts](./src/vs/workbench/contrib/acpChat/browser/components/markdownRenderer.ts)
```typescript
import { marked } from 'marked';

export function renderMarkdown(text: string): string {
	return marked.parse(text, { async: false }) as string;
}
```

and in [package.json](./package.json)

```json

     "@xterm/xterm": "^5.5.0",
+    "marked": "^18.0.5",
     "monaco-editor": "^0.52.2",
```

declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
	export default component;
	interface ElementAttrs extends AriaAttributes, DOMAttributes<T> {
		"data-tooltip"?: string;
	}
}
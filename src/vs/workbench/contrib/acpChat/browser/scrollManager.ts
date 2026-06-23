/*---------------------------------------------------------------------------------------------
 *  ScrollManager — smart auto-scroll for chat message streams.
 *
 *  Uses a ResizeObserver on the messages container to detect when content
 *  grows (streaming chunks, mermaid renders, tool views, image loads) and
 *  re-pins to the bottom if the user was at the bottom. This is the same
 *  approach used by use-stick-to-bottom (stackblitz-labs), the battle-tested
 *  React hook for AI chat scroll. It does not rely on CSS overflow-anchor,
 *  which has unreliable behavior in webview environments.
 *
 *  The ResizeObserver fires before the resulting scroll event, so we set a
 *  flag (_resizeScroll) that tells _handleScroll to ignore the next scroll.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as DOM from '../../../../base/browser/dom.js';

export class ScrollManager extends Disposable {

	private _userScrolledUp = false;
	private readonly _threshold = 40;

	// Flag set by ResizeObserver callback so _handleScroll knows the scroll
	// was caused by a content resize, not by the user.
	private _resizeScroll = false;

	private readonly _onUserScrollUp = this._register(new Emitter<void>());
	readonly onUserScrollUp: Event<void> = this._onUserScrollUp.event;

	private readonly _onUserScrollDown = this._register(new Emitter<void>());
	readonly onUserScrollDown: Event<void> = this._onUserScrollDown.event;

	constructor(
		private readonly _messagesEl: HTMLElement,
		private readonly _sentinelEl: HTMLElement,
	) {
		super();
		this._register(DOM.addDisposableListener(this._messagesEl, 'scroll', () => this._handleScroll()));

		// VSCode's DomScrollableElement in the parent chain intercepts wheel events
		// with { passive: false } in CAPTURE phase and calls preventDefault(), which
		// kills native overflow-y: auto scrolling on .sc-messages. We must intercept
		// in capture phase (before parent handlers), manually scroll, and preventDefault()
		// to stop the event from reaching those parent handlers.
		this._register(DOM.addDisposableListener(this._messagesEl, 'wheel', (e: WheelEvent) => {
			const el = this._messagesEl;
			const hasScrollableContent = el.scrollHeight > el.clientHeight;
			if (!hasScrollableContent) {
				return;
			}
			const atTop = el.scrollTop <= 0;
			const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
			const scrollingUp = e.deltaY < 0;
			const scrollingDown = e.deltaY > 0;
			if ((scrollingUp && !atTop) || (scrollingDown && !atBottom)) {
				const newScrollTop = el.scrollTop + e.deltaY;
				el.scrollTop = Math.max(0, Math.min(newScrollTop, el.scrollHeight - el.clientHeight));
				e.preventDefault();
				e.stopPropagation();
			}
		}, true));

		// ResizeObserver: detect when content inside .sc-messages grows.
		// This fires for any height change — streaming text, mermaid SVG
		// injection, tool views rendering, images loading, etc.
		const observer = new DOM.DisposableResizeObserver(() => {
			// Content height changed. If the user was at the bottom, re-pin.
			// Set the flag BEFORE scrolling so _handleScroll ignores the
			// scroll event that this programmatic scroll will produce.
			this._resizeScroll = true;
			if (!this._userScrolledUp) {
				this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
			}
		});
		observer.observe(this._messagesEl);
		this._register(observer);
	}

	get isUserScrolledUp(): boolean {
		return this._userScrolledUp;
	}

	private _handleScroll(): void {
		// This scroll was caused by our ResizeObserver handler re-pinning
		// to the bottom — not by the user. Ignore it.
		if (this._resizeScroll) {
			this._resizeScroll = false;
			return;
		}

		const el = this._messagesEl;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= this._threshold;

		if (!atBottom && !this._userScrolledUp) {
			this._userScrolledUp = true;
			this._onUserScrollUp.fire();
		} else if (atBottom && this._userScrolledUp) {
			this._userScrolledUp = false;
			this._onUserScrollDown.fire();
		}
	}

	/** Scroll to bottom only if user hasn't scrolled up. */
	scrollToBottom(): void {
		if (!this._userScrolledUp) {
			this._resizeScroll = true;
			this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
		}
	}

	/** Force scroll to bottom regardless of user scroll state (e.g. on send, tab return). */
	forceScrollToBottom(): void {
		this._userScrolledUp = false;
		this._resizeScroll = true;
		this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
		this._onUserScrollDown.fire();
	}

	/** Reset scroll state (e.g. when messages are cleared). */
	reset(): void {
		this._userScrolledUp = false;
		this._resizeScroll = false;
	}
}

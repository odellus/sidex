/*---------------------------------------------------------------------------------------------
 *  ScrollManager — smart auto-scroll for chat message streams.
 *
 *  Detects when the user scrolls up during streaming and pauses auto-scroll.
 *  Uses CSS overflow-anchor on a bottom sentinel for free auto-scroll when
 *  content grows within existing messages (no JS needed for that case).
 *
 *  Ported from crow-ui's ChatPane scroll logic.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import * as DOM from '../../../../base/browser/dom.js';

export class ScrollManager extends Disposable {

	private _userScrolledUp = false;
	private _isProgrammaticScroll = false;
	private readonly _threshold = 40;

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
				return; // nothing to scroll, let parent handle it
			}
			const atTop = el.scrollTop <= 0;
			const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
			const scrollingUp = e.deltaY < 0;
			const scrollingDown = e.deltaY > 0;
			// Only handle when scrolling would actually scroll this container.
			// If user is at top scrolling up, or at bottom scrolling down, let parent handle it.
			if ((scrollingUp && !atTop) || (scrollingDown && !atBottom)) {
				// Manually scroll since parent handlers would preventDefault() native scroll
				const newScrollTop = el.scrollTop + e.deltaY;
				el.scrollTop = Math.max(0, Math.min(newScrollTop, el.scrollHeight - el.clientHeight));
				
				// Prevent the event from reaching parent handlers
				e.preventDefault();
				e.stopPropagation();
			}
		}, true)); // true = use capture phase to run before parent handlers
	}

	get isUserScrolledUp(): boolean {
		return this._userScrolledUp;
	}

	private _handleScroll(): void {
		if (this._isProgrammaticScroll) {
			this._isProgrammaticScroll = false;
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
			this._isProgrammaticScroll = true;
			this._sentinelEl.scrollIntoView({ behavior: 'instant' });
		}
	}

	/** Force scroll to bottom regardless of user scroll state (e.g. "Jump" button click). */
	forceScrollToBottom(): void {
		this._userScrolledUp = false;
		this._isProgrammaticScroll = true;
		this._sentinelEl.scrollIntoView({ behavior: 'instant' });
		this._onUserScrollDown.fire();
	}

	/** Reset scroll state (e.g. when messages are cleared). */
	reset(): void {
		this._userScrolledUp = false;
		this._isProgrammaticScroll = false;
	}
}

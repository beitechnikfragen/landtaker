import { LitElement, TemplateResult, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../../Utils";

type ButtonVariant = "primary" | "secondary" | "danger" | "warning" | "ghost";
type ButtonSize = "xs" | "sm" | "md" | "lg";
type ButtonWidth = "auto" | "block" | "blockDesktop" | "fill";
type IconPosition = "left" | "right" | "only";

@customElement("o-button")
export class OButton extends LitElement {
  @property() title = "";
  @property() translationKey = "";
  @property() variant: ButtonVariant = "primary";
  @property() size: ButtonSize = "md";
  @property() width: ButtonWidth = "auto";
  @property() iconPosition: IconPosition = "left";
  @property({ attribute: false }) icon?: TemplateResult;
  @property({ type: Boolean }) disable = false;
  @property({ type: Boolean }) submit = false;

  createRenderRoot() {
    return this;
  }

  // Landtaker chrome: hard edges, the display face, colour changes on hover
  // instead of lift-and-glow. Danger/warning keep their semantic colours but
  // as flat plates.
  private readonly BASE =
    "font-[family-name:var(--font-lt-display)] font-semibold uppercase tracking-[0.14em] border " +
    "transition-colors duration-150 " +
    "outline-none focus-visible:outline-2 focus-visible:outline-lt-accent focus-visible:-outline-offset-2 " +
    "text-center whitespace-normal break-words leading-tight overflow-hidden relative " +
    "disabled:cursor-not-allowed disabled:opacity-40";

  private variantClasses(): string {
    switch (this.variant) {
      case "primary":
        return "bg-lt-accent border-lt-accent text-lt-accent-ink hover:bg-lt-accent-hi hover:border-lt-accent-hi disabled:hover:bg-lt-accent";
      case "secondary":
        return "bg-lt-800 border-lt-600 text-lt-100 hover:bg-lt-750 hover:border-lt-500 disabled:hover:bg-lt-800";
      case "danger":
        return "bg-lt-bad/15 border-lt-bad/60 text-lt-bad hover:bg-lt-bad hover:text-lt-100 disabled:hover:bg-lt-bad/15 disabled:hover:text-lt-bad";
      case "warning":
        return "bg-lt-gold/15 border-lt-gold/60 text-lt-gold hover:bg-lt-gold hover:text-lt-accent-ink disabled:hover:bg-lt-gold/15 disabled:hover:text-lt-gold";
      case "ghost":
        return "bg-transparent border-transparent text-lt-400 hover:text-lt-100 hover:bg-white/5 disabled:hover:bg-transparent disabled:hover:text-lt-400";
    }
  }

  private sizeClasses(): string {
    if (this.iconPosition === "only") {
      switch (this.size) {
        case "xs":
          return "w-6 h-6 text-xs";
        case "sm":
          return "w-8 h-8 text-sm";
        case "md":
          return "w-10 h-10 text-base";
        case "lg":
          return "w-12 h-12 text-lg";
      }
    }
    switch (this.size) {
      case "xs":
        return "py-1 px-2 text-xs";
      case "sm":
        return "py-1.5 px-3 text-sm";
      case "md":
        return "py-3 px-4 text-base lg:text-lg";
      case "lg":
        return "py-4 px-6 text-lg lg:text-xl";
    }
  }

  private widthClasses(): string {
    switch (this.width) {
      case "auto":
        return "inline-flex items-center justify-center gap-2";
      case "block":
        return "flex w-full items-center justify-center gap-2";
      case "blockDesktop":
        return "flex w-full items-center justify-center gap-2 lg:w-1/2 lg:mx-auto";
      case "fill":
        return "flex w-full h-full items-center justify-center gap-2";
    }
  }

  render() {
    const label =
      this.translationKey === ""
        ? this.title
        : translateText(this.translationKey);
    const iconOnly = this.iconPosition === "only";
    const classes = `${this.BASE} ${this.variantClasses()} ${this.sizeClasses()} ${this.widthClasses()}`;

    return html`
      <button
        class=${classes}
        ?disabled=${this.disable}
        type=${this.submit ? "submit" : "button"}
        aria-label=${iconOnly ? label : nothing}
      >
        ${this.icon && this.iconPosition !== "right" ? this.icon : nothing}
        ${iconOnly ? nothing : html`<span class="min-w-0">${label}</span>`}
        ${this.icon && this.iconPosition === "right" ? this.icon : nothing}
      </button>
    `;
  }
}

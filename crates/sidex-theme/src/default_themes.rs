//! Built-in default themes ported from VS Code.
//!
//! Provides four const-constructable themes: Default Dark Modern,
//! Default Light Modern, High Contrast, and High Contrast Light.

use crate::color::Color;
use crate::theme::{Theme, ThemeKind};
use crate::token_color::{FontStyle, TokenColorRule};
use crate::workbench_colors::WorkbenchColors;

/// "Default Dark Modern" — the VS Code default dark theme.
pub fn dark_modern() -> Theme {
    Theme {
        name: "Default Dark Modern".to_owned(),
        kind: ThemeKind::Dark,
        token_colors: dark_modern_tokens(),
        workbench_colors: WorkbenchColors::default_dark(),
    }
}

/// "Default Light Modern" — the VS Code default light theme.
pub fn light_modern() -> Theme {
    Theme {
        name: "Default Light Modern".to_owned(),
        kind: ThemeKind::Light,
        token_colors: light_modern_tokens(),
        workbench_colors: WorkbenchColors::default_light(),
    }
}

/// "Default High Contrast" — dark high-contrast theme.
pub fn hc_black() -> Theme {
    Theme {
        name: "Default High Contrast".to_owned(),
        kind: ThemeKind::HighContrast,
        token_colors: hc_black_tokens(),
        workbench_colors: hc_black_colors(),
    }
}

/// "Default High Contrast Light" — light high-contrast theme.
pub fn hc_light() -> Theme {
    Theme {
        name: "Default High Contrast Light".to_owned(),
        kind: ThemeKind::HighContrastLight,
        token_colors: hc_light_tokens(),
        workbench_colors: hc_light_colors(),
    }
}

/// "Crow Purple" — vibrant purple theme with excellent syntax highlighting.
pub fn crow_purple() -> Theme {
    Theme {
        name: "Crow Purple".to_owned(),
        kind: ThemeKind::Dark,
        token_colors: crow_purple_tokens(),
        workbench_colors: crow_purple_colors(),
    }
}

fn tok(scope: &str, fg: &str) -> TokenColorRule {
    TokenColorRule {
        name: None,
        scope: vec![scope.to_owned()],
        foreground: Color::from_hex(fg).ok(),
        background: None,
        font_style: FontStyle::NONE,
    }
}

fn tok_multi(scopes: &[&str], fg: &str) -> TokenColorRule {
    TokenColorRule {
        name: None,
        scope: scopes.iter().map(|s| (*s).to_owned()).collect(),
        foreground: Color::from_hex(fg).ok(),
        background: None,
        font_style: FontStyle::NONE,
    }
}

fn tok_styled(scope: &str, fg: &str, style: FontStyle) -> TokenColorRule {
    TokenColorRule {
        name: None,
        scope: vec![scope.to_owned()],
        foreground: Color::from_hex(fg).ok(),
        background: None,
        font_style: style,
    }
}

fn c(hex: &str) -> Option<Color> {
    Color::from_hex(hex).ok()
}

// ── Dark Modern token colors (from dark_plus / dark_modern base) ──────────

#[allow(clippy::too_many_lines)]
fn dark_modern_tokens() -> Vec<TokenColorRule> {
    vec![
        // Comments
        tok_styled("comment", "#6A9955", FontStyle::ITALIC),
        tok_styled("comment.line", "#6A9955", FontStyle::ITALIC),
        tok_styled("comment.block", "#6A9955", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#6A9955", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#6A9955"),
        // Strings
        tok("string", "#CE9178"),
        tok("string.quoted.single", "#CE9178"),
        tok("string.quoted.double", "#CE9178"),
        tok("string.template", "#CE9178"),
        tok("string.quoted.template", "#CE9178"),
        tok("string.regexp", "#D16969"),
        tok("string.interpolated", "#CE9178"),
        tok("constant.character.escape", "#D7BA7D"),
        tok_multi(&["string.quoted.triple", "string.quoted.raw"], "#CE9178"),
        // Numbers & constants
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
                "constant.numeric.octal",
                "constant.numeric.binary",
                "constant.other.color.rgb-value",
            ],
            "#B5CEA8",
        ),
        tok("constant.language", "#569CD6"),
        tok("constant.language.boolean", "#569CD6"),
        tok("constant.language.null", "#569CD6"),
        tok("constant.language.undefined", "#569CD6"),
        tok("constant.character", "#569CD6"),
        tok("constant.other", "#4FC1FF"),
        tok("constant.regexp", "#D16969"),
        // Variables
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#9CDCFE",
        ),
        tok("variable.other.readwrite", "#9CDCFE"),
        tok("variable.other.constant", "#4FC1FF"),
        tok("variable.other.enummember", "#4FC1FF"),
        tok("variable.other.property", "#9CDCFE"),
        tok("variable.other.object", "#9CDCFE"),
        tok("variable.parameter", "#9CDCFE"),
        tok("variable.language", "#569CD6"),
        tok("variable.language.this", "#569CD6"),
        tok("variable.language.self", "#569CD6"),
        tok("variable.language.super", "#569CD6"),
        tok("meta.object-literal.key", "#9CDCFE"),
        // Keywords
        tok("keyword", "#569CD6"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.loop",
                "keyword.control.conditional",
                "keyword.control.import",
                "keyword.control.from",
                "keyword.control.export",
                "keyword.other.using",
                "keyword.other.operator",
            ],
            "#C586C0",
        ),
        tok("keyword.operator", "#D4D4D4"),
        tok("keyword.operator.new", "#569CD6"),
        tok("keyword.operator.expression", "#569CD6"),
        tok("keyword.operator.logical", "#D4D4D4"),
        tok("keyword.operator.assignment", "#D4D4D4"),
        tok("keyword.operator.comparison", "#D4D4D4"),
        tok("keyword.operator.type", "#569CD6"),
        tok("keyword.operator.type.annotation", "#569CD6"),
        // Storage
        tok("storage", "#569CD6"),
        tok("storage.type", "#569CD6"),
        tok("storage.type.function", "#569CD6"),
        tok("storage.type.class", "#569CD6"),
        tok("storage.type.interface", "#569CD6"),
        tok("storage.type.enum", "#569CD6"),
        tok("storage.modifier", "#569CD6"),
        tok("storage.modifier.async", "#569CD6"),
        // Functions
        tok_multi(&["entity.name.function", "support.function"], "#DCDCAA"),
        tok("entity.name.function.member", "#DCDCAA"),
        tok("meta.function-call", "#DCDCAA"),
        tok("support.function.builtin", "#DCDCAA"),
        tok("entity.name.operator.custom-literal", "#DCDCAA"),
        // Types & classes
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#4EC9B0",
        ),
        tok("entity.name.type.parameter", "#4EC9B0"),
        tok("entity.name.type.enum", "#4EC9B0"),
        tok("entity.name.type.interface", "#4EC9B0"),
        tok("entity.name.type.alias", "#4EC9B0"),
        tok("entity.name.type.module", "#4EC9B0"),
        tok("entity.name.type.numeric", "#4EC9B0"),
        tok_multi(
            &["meta.type.cast.expr", "entity.other.inherited-class"],
            "#4EC9B0",
        ),
        tok("support.type.primitive", "#4EC9B0"),
        tok("entity.name.namespace", "#4EC9B0"),
        // Tags & attributes (HTML/XML/JSX)
        tok("entity.name.tag", "#569CD6"),
        tok("entity.name.tag.html", "#569CD6"),
        tok("entity.name.tag.css", "#D7BA7D"),
        tok("entity.other.attribute-name", "#9CDCFE"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
                "entity.other.attribute-name.pseudo-class.css",
                "entity.other.attribute-name.pseudo-element.css",
            ],
            "#D7BA7D",
        ),
        // CSS property values
        tok("support.constant.property-value.css", "#CE9178"),
        tok("support.constant.font-name", "#CE9178"),
        tok("support.constant.color", "#CE9178"),
        tok("constant.other.color.rgb-value.hex", "#CE9178"),
        // Decorators / attributes / annotations
        tok_multi(
            &[
                "meta.decorator",
                "entity.name.function.decorator",
                "punctuation.decorator",
            ],
            "#DCDCAA",
        ),
        tok_multi(
            &["entity.other.attribute-name.pragma", "meta.attribute"],
            "#9CDCFE",
        ),
        // Preprocessor / macros
        tok("meta.preprocessor", "#569CD6"),
        tok("meta.preprocessor.string", "#CE9178"),
        tok("meta.preprocessor.numeric", "#B5CEA8"),
        tok("entity.name.function.preprocessor", "#569CD6"),
        tok_multi(
            &[
                "keyword.control.directive",
                "punctuation.definition.directive",
            ],
            "#569CD6",
        ),
        // Operators & punctuation
        tok("support.constant", "#569CD6"),
        tok("punctuation.definition.tag", "#808080"),
        tok("punctuation.separator", "#D4D4D4"),
        tok("punctuation.terminator", "#D4D4D4"),
        tok("punctuation.section", "#D4D4D4"),
        tok("punctuation.accessor", "#D4D4D4"),
        tok("meta.brace", "#D4D4D4"),
        // JSON
        tok("support.type.property-name.json", "#9CDCFE"),
        tok("string.value.json", "#CE9178"),
        // YAML
        tok("entity.name.tag.yaml", "#569CD6"),
        // TOML
        tok("entity.name.tag.toml", "#569CD6"),
        tok("support.type.property-name.toml", "#9CDCFE"),
        // Markup (Markdown, etc.)
        tok_styled("emphasis", "#D4D4D4", FontStyle::ITALIC),
        tok_styled("strong", "#D4D4D4", FontStyle::BOLD),
        tok_styled("markup.heading", "#6796E6", FontStyle::BOLD),
        tok_styled("markup.heading.setext", "#6796E6", FontStyle::BOLD),
        tok("markup.inserted", "#B5CEA8"),
        tok("markup.deleted", "#CE9178"),
        tok("markup.changed", "#569CD6"),
        tok_styled("markup.italic", "#D4D4D4", FontStyle::ITALIC),
        tok_styled("markup.bold", "#D4D4D4", FontStyle::BOLD),
        tok_styled("markup.underline", "#D4D4D4", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#D4D4D4", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#CE9178"),
        tok("markup.fenced_code.block", "#CE9178"),
        tok("markup.quote", "#6A9955"),
        tok("markup.list.numbered", "#6796E6"),
        tok("markup.list.unnumbered", "#6796E6"),
        tok("meta.link.inline.markdown", "#4daafc"),
        tok("string.other.link", "#4daafc"),
        // Rust-specific
        tok("entity.name.type.lifetime.rust", "#569CD6"),
        tok("keyword.operator.borrow.rust", "#569CD6"),
        tok("keyword.operator.sigil.rust", "#569CD6"),
        tok("entity.name.function.macro.rust", "#DCDCAA"),
        tok("meta.attribute.rust", "#9CDCFE"),
        // Invalid / deprecated
        tok("invalid", "#F44747"),
        tok("invalid.illegal", "#F44747"),
        tok_styled("invalid.deprecated", "#DCDCAA", FontStyle::STRIKETHROUGH),
    ]
}

#[allow(clippy::too_many_lines)]
fn light_modern_tokens() -> Vec<TokenColorRule> {
    vec![
        // Comments
        tok_styled("comment", "#008000", FontStyle::ITALIC),
        tok_styled("comment.line", "#008000", FontStyle::ITALIC),
        tok_styled("comment.block", "#008000", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#008000", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#008000"),
        // Strings
        tok("string", "#A31515"),
        tok("string.quoted.single", "#A31515"),
        tok("string.quoted.double", "#A31515"),
        tok("string.template", "#A31515"),
        tok("string.regexp", "#811F3F"),
        tok("string.interpolated", "#A31515"),
        tok("constant.character.escape", "#FF0000"),
        tok_multi(&["string.quoted.triple", "string.quoted.raw"], "#A31515"),
        // Numbers & constants
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
                "constant.numeric.octal",
                "constant.numeric.binary",
            ],
            "#098658",
        ),
        tok("constant.language", "#0000FF"),
        tok("constant.language.boolean", "#0000FF"),
        tok("constant.language.null", "#0000FF"),
        tok("constant.language.undefined", "#0000FF"),
        tok("constant.character", "#0000FF"),
        tok("constant.other", "#0070C1"),
        tok("constant.regexp", "#811F3F"),
        // Variables
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#001080",
        ),
        tok("variable.other.readwrite", "#001080"),
        tok("variable.other.constant", "#0070C1"),
        tok("variable.other.enummember", "#0070C1"),
        tok("variable.other.property", "#001080"),
        tok("variable.other.object", "#001080"),
        tok("variable.parameter", "#001080"),
        tok("variable.language", "#0000FF"),
        tok("variable.language.this", "#0000FF"),
        tok("variable.language.self", "#0000FF"),
        tok("meta.object-literal.key", "#001080"),
        // Keywords
        tok("keyword", "#0000FF"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.loop",
                "keyword.control.conditional",
                "keyword.control.import",
                "keyword.control.from",
                "keyword.control.export",
                "keyword.other.using",
            ],
            "#AF00DB",
        ),
        tok("keyword.operator", "#000000"),
        tok("keyword.operator.new", "#0000FF"),
        tok("keyword.operator.expression", "#0000FF"),
        tok("keyword.operator.logical", "#000000"),
        tok("keyword.operator.type", "#0000FF"),
        // Storage
        tok("storage", "#0000FF"),
        tok("storage.type", "#0000FF"),
        tok("storage.type.function", "#0000FF"),
        tok("storage.type.class", "#0000FF"),
        tok("storage.modifier", "#0000FF"),
        tok("storage.modifier.async", "#0000FF"),
        // Functions
        tok_multi(&["entity.name.function", "support.function"], "#795E26"),
        tok("entity.name.function.member", "#795E26"),
        tok("meta.function-call", "#795E26"),
        tok("support.function.builtin", "#795E26"),
        tok("entity.name.operator.custom-literal", "#795E26"),
        // Types & classes
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#267F99",
        ),
        tok("entity.name.type.parameter", "#267F99"),
        tok("entity.name.type.enum", "#267F99"),
        tok("entity.name.type.interface", "#267F99"),
        tok("entity.name.type.alias", "#267F99"),
        tok("entity.name.type.module", "#267F99"),
        tok("support.type.primitive", "#267F99"),
        tok("entity.name.namespace", "#267F99"),
        tok_multi(
            &["meta.type.cast.expr", "entity.other.inherited-class"],
            "#267F99",
        ),
        // Tags & attributes
        tok("entity.name.tag", "#800000"),
        tok("entity.name.tag.css", "#800000"),
        tok("entity.other.attribute-name", "#E50000"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
                "entity.other.attribute-name.pseudo-class.css",
            ],
            "#800000",
        ),
        // CSS
        tok("support.constant.property-value.css", "#A31515"),
        tok("support.constant.font-name", "#A31515"),
        // Decorators / annotations
        tok_multi(
            &[
                "meta.decorator",
                "entity.name.function.decorator",
                "punctuation.decorator",
            ],
            "#795E26",
        ),
        tok("meta.attribute", "#E50000"),
        // Preprocessor / macros
        tok("meta.preprocessor", "#0000FF"),
        tok("meta.preprocessor.string", "#A31515"),
        tok("meta.preprocessor.numeric", "#098658"),
        tok("entity.name.function.preprocessor", "#0000FF"),
        tok_multi(
            &[
                "keyword.control.directive",
                "punctuation.definition.directive",
            ],
            "#0000FF",
        ),
        // Operators & punctuation
        tok("support.constant", "#0000FF"),
        tok("punctuation.definition.tag", "#800000"),
        tok("punctuation.separator", "#000000"),
        tok("punctuation.terminator", "#000000"),
        tok("meta.brace", "#000000"),
        // JSON
        tok("support.type.property-name.json", "#0451A5"),
        tok("string.value.json", "#A31515"),
        // YAML
        tok("entity.name.tag.yaml", "#800000"),
        // TOML
        tok("support.type.property-name.toml", "#0451A5"),
        // Markup
        tok_styled("emphasis", "#000000", FontStyle::ITALIC),
        tok_styled("strong", "#000000", FontStyle::BOLD),
        tok_styled("markup.heading", "#0451A5", FontStyle::BOLD),
        tok("markup.inserted", "#098658"),
        tok("markup.deleted", "#A31515"),
        tok("markup.changed", "#0451A5"),
        tok_styled("markup.italic", "#000000", FontStyle::ITALIC),
        tok_styled("markup.bold", "#000000", FontStyle::BOLD),
        tok_styled("markup.underline", "#000000", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#000000", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#A31515"),
        tok("markup.fenced_code.block", "#A31515"),
        tok("markup.quote", "#008000"),
        tok("markup.list.numbered", "#0451A5"),
        tok("markup.list.unnumbered", "#0451A5"),
        tok("meta.link.inline.markdown", "#0451A5"),
        tok("string.other.link", "#0451A5"),
        // Rust-specific
        tok("entity.name.type.lifetime.rust", "#0000FF"),
        tok("keyword.operator.borrow.rust", "#0000FF"),
        tok("entity.name.function.macro.rust", "#795E26"),
        tok("meta.attribute.rust", "#E50000"),
        // Invalid / deprecated
        tok("invalid", "#CD3131"),
        tok("invalid.illegal", "#CD3131"),
        tok_styled("invalid.deprecated", "#795E26", FontStyle::STRIKETHROUGH),
    ]
}

#[allow(clippy::too_many_lines)]
fn hc_black_tokens() -> Vec<TokenColorRule> {
    vec![
        tok_styled("comment", "#7CA668", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#7CA668", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#7CA668"),
        tok("string", "#CE9178"),
        tok("string.quoted.single", "#CE9178"),
        tok("string.quoted.double", "#CE9178"),
        tok("string.template", "#CE9178"),
        tok("string.regexp", "#D16969"),
        tok("string.interpolated", "#CE9178"),
        tok("constant.character.escape", "#D7BA7D"),
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
                "constant.other.color.rgb-value",
            ],
            "#B5CEA8",
        ),
        tok("constant.language", "#569CD6"),
        tok("constant.language.boolean", "#569CD6"),
        tok("constant.language.null", "#569CD6"),
        tok("constant.character", "#569CD6"),
        tok("constant.other", "#4FC1FF"),
        tok("constant.regexp", "#B46695"),
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#9CDCFE",
        ),
        tok("variable.other.readwrite", "#9CDCFE"),
        tok("variable.other.constant", "#4FC1FF"),
        tok("variable.other.enummember", "#4FC1FF"),
        tok("variable.other.property", "#9CDCFE"),
        tok("variable.parameter", "#9CDCFE"),
        tok("variable.language", "#569CD6"),
        tok("keyword", "#569CD6"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.import",
                "keyword.other.using",
                "keyword.other.operator",
            ],
            "#C586C0",
        ),
        tok("keyword.operator", "#D4D4D4"),
        tok("keyword.operator.new", "#569CD6"),
        tok("keyword.operator.type", "#569CD6"),
        tok("storage", "#569CD6"),
        tok("storage.type", "#569CD6"),
        tok("storage.modifier", "#569CD6"),
        tok_multi(&["entity.name.function", "support.function"], "#DCDCAA"),
        tok("entity.name.function.member", "#DCDCAA"),
        tok("support.function.builtin", "#DCDCAA"),
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#4EC9B0",
        ),
        tok("entity.name.type.parameter", "#4EC9B0"),
        tok("entity.name.type.enum", "#4EC9B0"),
        tok("entity.name.namespace", "#4EC9B0"),
        tok("support.type.primitive", "#4EC9B0"),
        tok("entity.name.tag", "#569CD6"),
        tok_multi(&["entity.name.tag.css", "entity.name.tag.less"], "#D7BA7D"),
        tok("entity.other.attribute-name", "#9CDCFE"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
            ],
            "#D7BA7D",
        ),
        tok_multi(
            &["meta.decorator", "entity.name.function.decorator"],
            "#DCDCAA",
        ),
        tok("meta.preprocessor", "#569CD6"),
        tok("meta.preprocessor.string", "#CE9178"),
        tok("meta.preprocessor.numeric", "#B5CEA8"),
        tok("punctuation.definition.tag", "#808080"),
        tok("support.constant", "#569CD6"),
        tok("support.type.property-name.json", "#9CDCFE"),
        tok("meta.attribute.rust", "#9CDCFE"),
        tok("entity.name.function.macro.rust", "#DCDCAA"),
        tok("invalid", "#F44747"),
        tok("invalid.illegal", "#F44747"),
        tok_styled("invalid.deprecated", "#DCDCAA", FontStyle::STRIKETHROUGH),
        tok_styled("emphasis", "#FFFFFF", FontStyle::ITALIC),
        tok_styled("strong", "#FFFFFF", FontStyle::BOLD),
        tok_styled("markup.heading", "#6796E6", FontStyle::BOLD),
        tok("markup.inserted", "#B5CEA8"),
        tok("markup.deleted", "#CE9178"),
        tok("markup.changed", "#569CD6"),
        tok_styled("markup.italic", "#FFFFFF", FontStyle::ITALIC),
        tok_styled("markup.bold", "#FFFFFF", FontStyle::BOLD),
        tok_styled("markup.underline", "#FFFFFF", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#FFFFFF", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#CE9178"),
        tok("markup.quote", "#7CA668"),
    ]
}

#[allow(clippy::too_many_lines)]
fn hc_light_tokens() -> Vec<TokenColorRule> {
    vec![
        tok_styled("comment", "#515151", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#515151", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#515151"),
        tok_multi(&["string", "meta.embedded.assembly"], "#0F4A85"),
        tok("string.quoted.single", "#0F4A85"),
        tok("string.quoted.double", "#0F4A85"),
        tok("string.template", "#0F4A85"),
        tok("string.regexp", "#811F3F"),
        tok("string.interpolated", "#0F4A85"),
        tok("constant.character.escape", "#EE0000"),
        tok_multi(
            &[
                "constant.numeric",
                "constant.numeric.integer",
                "constant.numeric.float",
                "constant.numeric.hex",
            ],
            "#096D48",
        ),
        tok("constant.language", "#0F4A85"),
        tok("constant.language.boolean", "#0F4A85"),
        tok("constant.language.null", "#0F4A85"),
        tok("constant.character", "#0F4A85"),
        tok("constant.other", "#0F4A85"),
        tok_multi(
            &[
                "variable",
                "meta.definition.variable.name",
                "support.variable",
            ],
            "#001080",
        ),
        tok("variable.other.readwrite", "#001080"),
        tok("variable.other.constant", "#0070C1"),
        tok("variable.other.enummember", "#0070C1"),
        tok("variable.other.property", "#001080"),
        tok("variable.parameter", "#001080"),
        tok("variable.language", "#0F4A85"),
        tok("keyword", "#0F4A85"),
        tok_multi(
            &[
                "keyword.control",
                "keyword.control.flow",
                "keyword.control.import",
                "keyword.other.using",
            ],
            "#B5200D",
        ),
        tok("keyword.operator", "#000000"),
        tok("keyword.operator.new", "#0F4A85"),
        tok("keyword.operator.type", "#0F4A85"),
        tok("storage", "#0F4A85"),
        tok("storage.type", "#0F4A85"),
        tok("storage.modifier", "#0F4A85"),
        tok_multi(&["entity.name.function", "support.function"], "#5E2CBC"),
        tok("entity.name.function.member", "#5E2CBC"),
        tok("support.function.builtin", "#5E2CBC"),
        tok_multi(
            &[
                "entity.name.type",
                "entity.name.class",
                "support.class",
                "support.type",
            ],
            "#185E73",
        ),
        tok("entity.name.type.parameter", "#185E73"),
        tok("entity.name.type.enum", "#185E73"),
        tok("entity.name.namespace", "#185E73"),
        tok("support.type.primitive", "#185E73"),
        tok("entity.name.tag", "#0F4A85"),
        tok("entity.other.attribute-name", "#264F78"),
        tok_multi(
            &[
                "entity.other.attribute-name.class.css",
                "entity.other.attribute-name.id.css",
            ],
            "#264F78",
        ),
        tok_multi(
            &["meta.decorator", "entity.name.function.decorator"],
            "#5E2CBC",
        ),
        tok("meta.preprocessor", "#0F4A85"),
        tok("meta.preprocessor.string", "#0F4A85"),
        tok("meta.preprocessor.numeric", "#096D48"),
        tok("punctuation.definition.tag", "#0F4A85"),
        tok("support.constant", "#0F4A85"),
        tok("support.type.property-name.json", "#264F78"),
        tok("meta.attribute.rust", "#264F78"),
        tok("entity.name.function.macro.rust", "#5E2CBC"),
        tok("invalid", "#B5200D"),
        tok("invalid.illegal", "#B5200D"),
        tok_styled("invalid.deprecated", "#5E2CBC", FontStyle::STRIKETHROUGH),
        tok_styled("emphasis", "#000000", FontStyle::ITALIC),
        tok_styled("strong", "#000080", FontStyle::BOLD),
        tok_styled("markup.heading", "#0F4A85", FontStyle::BOLD),
        tok("markup.inserted", "#096D48"),
        tok("markup.deleted", "#5A5A5A"),
        tok("markup.changed", "#0451A5"),
        tok_styled("markup.italic", "#800080", FontStyle::ITALIC),
        tok_styled("markup.bold", "#000080", FontStyle::BOLD),
        tok_styled("markup.underline", "#000000", FontStyle::UNDERLINE),
        tok_styled("markup.strikethrough", "#000000", FontStyle::STRIKETHROUGH),
        tok("markup.inline.raw", "#0F4A85"),
        tok("markup.quote", "#515151"),
    ]
}

#[allow(clippy::too_many_lines)]
fn hc_black_colors() -> WorkbenchColors {
    WorkbenchColors {
        editor_background: c("#000000"),
        editor_foreground: c("#FFFFFF"),
        editor_selection_background: c("#FFFFFF"),
        editor_whitespace_foreground: c("#7c7c7c"),
        editor_indent_guide_background: c("#FFFFFF"),
        editor_indent_guide_active_background: c("#FFFFFF"),
        side_bar_title_foreground: c("#FFFFFF"),
        selection_background: c("#008000"),
        foreground: c("#FFFFFF"),
        focus_border: c("#F38518"),
        contrast_border: c("#6FC3DF"),
        contrast_active_border: c("#F38518"),
        error_foreground: c("#F48771"),
        text_link_foreground: c("#21A6FF"),
        text_link_active_foreground: c("#21A6FF"),
        icon_foreground: c("#FFFFFF"),
        ..WorkbenchColors::default()
    }
}

#[allow(clippy::too_many_lines)]
fn hc_light_colors() -> WorkbenchColors {
    WorkbenchColors {
        editor_background: c("#FFFFFF"),
        editor_foreground: c("#292929"),
        foreground: c("#292929"),
        focus_border: c("#006BBD"),
        contrast_border: c("#0F4A85"),
        contrast_active_border: c("#006BBD"),
        error_foreground: c("#B5200D"),
        text_link_foreground: c("#0F4A85"),
        text_link_active_foreground: c("#0F4A85"),
        icon_foreground: c("#292929"),
        status_bar_item_remote_background: c("#FFFFFF"),
        status_bar_item_remote_foreground: c("#000000"),
        ..WorkbenchColors::default()
    }
}

// ── Crow Purple workbench colors (based on Shades of Purple) ──────────

#[allow(clippy::too_many_lines)]
fn crow_purple_colors() -> WorkbenchColors {
    WorkbenchColors {
        // Editor
        editor_background: c("#2D2B55"),
        editor_foreground: c("#FFFFFF"),
        editor_line_highlight_background: c("#1F1F41"),
        editor_selection_background: c("#B362FF88"),
        editor_inactive_selection_background: c("#7580B8C0"),
        editor_selection_highlight_background: c("#7E46DF46"),
        editor_word_highlight_background: c("#FFFFFF0D"),
        editor_word_highlight_strong_background: c("#FFFFFF0D"),
        editor_find_match_background: c("#ff7300ab"),
        editor_find_match_highlight_background: c("#FFFF0336"),
        editor_find_range_highlight_background: c("#FFFF0336"),
        editor_line_number_foreground: c("#A599E9"),
        editor_cursor_foreground: c("#39FF14"),
        editor_whitespace_foreground: c("#FFFFFF1A"),
        editor_indent_guide_background: c("#A599E90F"),
        editor_indent_guide_active_background: c("#A599E942"),
        editor_ruler_foreground: c("#A599E91C"),
        editor_bracket_match_background: c("#AD70FC46"),
        editor_bracket_match_border: c("#AD70FC46"),
        editor_overview_ruler_border: c("#A599E91C"),
        editor_gutter_added_background: c("#35AD68"),
        editor_gutter_modified_background: c("#AD70FC46"),
        editor_gutter_deleted_background: c("#EC3A37F5"),
        editor_error_foreground: c("#EC3A37F5"),
        editor_warning_foreground: c("#39FF14"),
        editor_hover_highlight_background: c("#1E1E3F80"),
        editor_link_active_foreground: c("#A599E9"),
        editor_widget_background: c("#222244"),
        editor_widget_border: c("#1F1F41"),
        editor_suggest_widget_background: c("#1F1F41"),
        editor_suggest_widget_border: c("#1F1F41"),
        editor_suggest_widget_foreground: c("#A599E9"),
        editor_suggest_widget_selected_background: c("#2D2B55"),
        editor_hover_widget_background: c("#161633"),
        editor_hover_widget_border: c("#161633"),

        // Sidebar
        side_bar_background: c("#222244"),
        side_bar_foreground: c("#A599E9"),
        side_bar_border: c("#25254B"),
        side_bar_title_foreground: c("#A599E9"),
        side_bar_section_header_background: c("#1E1E3F"),
        side_bar_section_header_foreground: c("#A599E9"),
        side_bar_section_header_border: c("#1E1E3F"),

        // Activity Bar
        activity_bar_background: c("#28284E"),
        activity_bar_foreground: c("#FFFFFF"),
        activity_bar_inactive_foreground: c("#A599E9"),
        activity_bar_border: c("#222244"),
        activity_bar_active_border: c("#6943ff62"),
        activity_bar_active_background: c("#222244"),
        activity_bar_badge_background: c("#39FF14"),
        activity_bar_badge_foreground: c("#1E1E3F"),

        // Status Bar
        status_bar_background: c("#1E1E3F"),
        status_bar_foreground: c("#A599E9"),
        status_bar_border: c("#1E1E3F"),
        status_bar_debugging_background: c("#39FF14"),
        status_bar_debugging_foreground: c("#1E1E3F"),
        status_bar_no_folder_background: c("#1E1E3F"),
        status_bar_no_folder_foreground: c("#A599E9"),
        status_bar_item_active_background: c("#4D21FC"),
        status_bar_item_hover_background: c("#4D21FC"),

        // Tabs
        tab_active_background: c("#222244"),
        tab_active_foreground: c("#FFFFFF"),
        tab_inactive_background: c("#2D2B55"),
        tab_inactive_foreground: c("#A599E9"),
        tab_border: c("#1E1E3F"),
        tab_active_border: c("#39FF14"),

        // Panel
        panel_background: c("#1E1E3F"),
        panel_border: c("#39FF14"),
        panel_title_active_foreground: c("#39FF14"),
        panel_title_active_border: c("#39FF14"),
        panel_title_inactive_foreground: c("#A599E9"),

        // Lists
        list_active_selection_background: c("#2D2B55"),
        list_active_selection_foreground: c("#FFFFFF"),
        list_focus_background: c("#2D2B55"),
        list_focus_foreground: c("#FFFFFF"),
        list_hover_background: c("#2D2B55"),
        list_hover_foreground: c("#CEC5FF"),
        list_inactive_selection_background: c("#2D2B55"),
        list_inactive_selection_foreground: c("#AAAAAA"),
        list_highlight_foreground: c("#39FF14"),
        list_drop_background: c("#2D2B55"),

        // Input
        input_background: c("#2D2B55"),
        input_foreground: c("#39FF14"),
        input_border: c("#1E1E3F"),
        input_placeholder_foreground: c("#A599E9"),

        // Button
        button_background: c("#39FF14dd"),
        button_foreground: c("#222244"),
        button_hover_background: c("#39FF14"),

        // Badge
        badge_background: c("#39FF14"),
        badge_foreground: c("#1E1E3F"),

        // Title Bar
        title_bar_active_background: c("#1E1E3F"),
        title_bar_active_foreground: c("#FFFFFF"),
        title_bar_inactive_background: c("#1E1E3F"),
        title_bar_inactive_foreground: c("#A599E9"),

        // Terminal
        terminal_background: c("#1E1E3F"),
        terminal_foreground: c("#FFFFFF"),
        terminal_cursor_foreground: c("#39FF14"),
        terminal_cursor_background: c("#39FF14"),

        // Git
        git_decoration_modified_resource_foreground: c("#39FF14"),
        git_decoration_deleted_resource_foreground: c("#EC3A37F5"),
        git_decoration_untracked_resource_foreground: c("#3AD900"),
        git_decoration_ignored_resource_foreground: c("#A599E981"),
        git_decoration_conflict_resource_foreground: c("#FF7200"),

        // Diff Editor
        diff_editor_inserted_text_background: c("#3AD90020"),
        diff_editor_removed_text_background: c("#EE3A4320"),

        // Editor Groups
        editor_group_border: c("#222244"),
        editor_group_header_tabs_background: c("#2D2B55"),
        editor_group_header_tabs_border: c("#1F1F41"),

        // Notifications
        notification_background: c("#1E1E3F"),
        notification_foreground: c("#CEC5FF"),
        notification_border: c("#2D2B55"),
        notification_center_header_background: c("#6943FF"),
        notification_center_header_foreground: c("#FFFFFF"),

        // Breadcrumbs
        breadcrumb_foreground: c("#A599E9"),
        breadcrumb_focus_foreground: c("#39FF14"),
        breadcrumb_active_selection_foreground: c("#FFFFFF"),
        breadcrumb_picker_background: c("#1E1E3F"),

        // Misc
        foreground: c("#A599E9"),
        focus_border: c("#1E1E3F"),
        error_foreground: c("#EC3A37F5"),
        description_foreground: c("#A599E9"),
        selection_background: c("#B362FF"),
        text_link_foreground: c("#B362FF"),
        text_link_active_foreground: c("#B362FF"),
        progress_bar_background: c("#39FF14"),
        sash_hover_border: c("#39FF14"),

        ..WorkbenchColors::default()
    }
}

// ── Crow Purple token colors ──────────

#[allow(clippy::too_many_lines)]
fn crow_purple_tokens() -> Vec<TokenColorRule> {
    vec![
        // Comments - Purple
        tok_styled("comment", "#B362FF", FontStyle::ITALIC),
        tok_styled("comment.line", "#B362FF", FontStyle::ITALIC),
        tok_styled("comment.block", "#B362FF", FontStyle::ITALIC),
        tok_styled("comment.block.documentation", "#B362FF", FontStyle::ITALIC),
        tok("punctuation.definition.comment", "#B362FF"),

        // Entity - Green
        tok("entity", "#39FF14"),
        tok("entity.name", "#39FF14"),
        tok("entity.name.type", "#80FFBB"),
        tok("entity.name.function", "#39FF14"),
        tok("entity.other.inherited-class", "#FFEE80"),

        // Constant - Pink
        tok("constant", "#FF628C"),
        tok("constant.numeric", "#FF628C"),
        tok("constant.language", "#FF628C"),
        tok("constant.character", "#FF628C"),

        // Keyword - Orange
        tok("keyword", "#FF9D00"),
        tok("keyword.control", "#FF9D00"),
        tok("keyword.operator", "#FF9D00"),
        tok_multi(&["keyword.other.rust", "keyword.other.nim"], "#FF9D00"),

        // Storage - Green
        tok("storage", "#39FF14"),
        tok("storage.type", "#FF9D00"),
        tok("storage.modifier", "#80FFBB"),
        tok_styled("storage.type.function", "#FB94FF", FontStyle::NONE),

        // String - Light Green
        tok("string", "#A5FF90"),
        tok("string.quoted", "#A5FF90"),
        tok("string.template", "#3AD900"),
        tok("punctuation.definition.string", "#A5FF90"),
        tok("string.regexp", "#FB94FF"),

        // Variable - Light Blue
        tok("variable", "#E1EFFF"),
        tok("variable.language", "#FB94FF"),
        tok("variable.parameter", "#9EFFFF"),
        tok("variable.other.property", "#FFEE80"),
        tok("variable.other.object.property", "#FFEE80"),
        tok_multi(
            &[
                "variable.other.readwrite",
                "variable.other.object",
                "variable.other.readwrite.alias",
            ],
            "#9EFFFF",
        ),

        // Support - Teal
        tok("support", "#80FFBB"),
        tok("support.function", "#FF9D00"),
        tok("support.class", "#9EFFFF"),
        tok("support.type", "#80FFBB"),

        // Punctuation - Light Blue
        tok("punctuation", "#E1EFFF"),
        tok("punctuation.definition.parameters", "#FFEE80"),
        tok("punctuation.definition.template-expression", "#FFEE80"),
        tok("meta.brace", "#E1EFFF"),

        // Meta - Cyan
        tok("meta", "#9EFFFF"),
        tok("meta.tag", "#9EFFFF"),
        tok("meta.object-literal.key", "#80FFBB"),

        // Invalid - Red
        tok("invalid", "#EC3A37F5"),

        // HTML/XML tags
        tok("entity.name.tag", "#9EFFFF"),
        tok("punctuation.definition.tag", "#9EFFFF"),
        tok("meta.tag.other", "#9EFFFF"),

        // CSS
        tok("entity.other.attribute-name.class.css", "#9EFFFF"),
        tok_multi(
            &[
                "entity.other.attribute-name.id.css",
                "entity.other.attribute-name.pseudo-class.css",
            ],
            "#FFB454",
        ),
        tok("source.css entity", "#3AD900"),
        tok("source.css support", "#A5FF90"),
        tok("source.css constant", "#FFEE80"),
        tok("source.css string", "#FFEE80"),
        tok("source.css variable", "#9EFFFF"),

        // JavaScript/TypeScript
        tok("source.js storage.type.function", "#FB94FF"),
        tok_multi(
            &[
                "entity.name.type.class.tsx",
                "entity.name.type.class.jsx",
                "entity.name.type.tsx",
                "entity.name.type.jsx",
            ],
            "#9EFFFF",
        ),
        tok("meta.jsx.children", "#FFFFFF"),
        tok("JSXNested", "#FFFFFF"),

        // Python
        tok("variable.parameter.function.language.special.self.python", "#9EFFFF"),
        tok_multi(
            &[
                "meta.function-call.python",
                "meta.function-call.generic.python",
                "support.function.builtin.python",
            ],
            "#39FF14",
        ),

        // Rust
        tok("keyword.other.fn.rust", "#FB94FF"),

        // Markdown
        tok_styled("entity.name.section.markdown", "#39FF14", FontStyle::BOLD),
        tok_styled("markup.heading", "#39FF14", FontStyle::BOLD),
        tok("meta.paragraph.markdown", "#FFFFFF"),
        tok("markup.inline.raw.string.markdown", "#A599E9"),
        tok_styled("markup.bold.markdown", "#FFFFFF", FontStyle::BOLD),
        tok_styled("markup.italic.markdown", "#FFFFFF", FontStyle::ITALIC),
        tok("markup.list.unnumbered.markdown", "#39FF14"),
        tok("markup.underline.link.markdown", "#A599E9"),
        tok("string.other.link.title.markdown", "#39FF14"),
        tok("string.other.link.description.title.markdown", "#A5FF90"),
        tok("markup.inserted", "#8efa00"),
        tok("markup.deleted", "#F16E6B"),

        // YAML
        tok("entity.name.tag.yaml", "#39FF14"),

        // JSON
        tok("source.json support", "#39FF14"),
        tok("source.json string", "#92FC79"),

        // TOML
        tok("keyword.key.toml", "#39FF14"),
        tok("entity.other.attribute-name.table.toml", "#FF9D00"),

        // Shell
        tok("storage.type.function.shell", "#FB94FF"),
        tok("variable.other.special.shell", "#FF9D00"),

        // SQL
        tok("source.sql keyword", "#FAEFA5"),
        tok("source.sql support.function", "#39FF14"),
        tok("keyword.other.DML.sql", "#FF9D00"),

        // Go
        tok_multi(&["keyword.package.go", "keyword.import.go"], "#FF9D00"),
        tok("keyword.function.go", "#FB94FF"),
        tok("variable.other.assignment.go", "#9EFFFF"),

        // Ruby
        tok("variable.other.constant.ruby", "#80FFBB"),
        tok("entity.name.type.class.ruby", "#FB94FF"),
        tok("variable.other.ruby", "#9EFFFF"),
        tok("keyword.other.special-method.ruby", "#FFEE80"),

        // PHP
        tok("entity.name.function.php", "#39FF14"),
        tok("variable.other.php", "#9EFFFF"),
        tok("keyword.other.phpdoc.php", "#FF9D00"),
        tok("storage.type.function.php", "#FB94FF"),

        // C#
        tok("storage.type.cs", "#9EFFFF"),
        tok("storage.modifier.cs", "#80FFBB"),

        // Git diff
        tok("markup.inserted.diff", "#8efa00"),
        tok("markup.deleted.diff", "#F16E6B"),
        tok("meta.diff.header", "#B362FF"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_modern_loads() {
        let t = dark_modern();
        assert_eq!(t.kind, ThemeKind::Dark);
        assert!(!t.token_colors.is_empty());
        assert!(t.workbench_colors.editor_background.is_some());
    }

    #[test]
    fn light_modern_loads() {
        let t = light_modern();
        assert_eq!(t.kind, ThemeKind::Light);
        assert!(!t.token_colors.is_empty());
    }

    #[test]
    fn hc_black_loads() {
        let t = hc_black();
        assert_eq!(t.kind, ThemeKind::HighContrast);
        assert_eq!(t.workbench_colors.editor_background, c("#000000"));
    }

    #[test]
    fn hc_light_loads() {
        let t = hc_light();
        assert_eq!(t.kind, ThemeKind::HighContrastLight);
        assert_eq!(t.workbench_colors.editor_background, c("#FFFFFF"));
    }

    #[test]
    fn crow_purple_loads() {
        let t = crow_purple();
        assert_eq!(t.kind, ThemeKind::Dark);
        assert_eq!(t.workbench_colors.editor_background, c("#2D2B55"));
        assert!(!t.token_colors.is_empty());
        assert!(t.token_colors.len() > 50, "Crow Purple should have comprehensive token colors");
    }
}

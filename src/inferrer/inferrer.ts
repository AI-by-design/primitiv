import type { TokenMap, ComponentMap } from '../types';

export interface InferredRule {
    id: string;
    category: 'spacing' | 'color' | 'typography' | 'border-radius' | 'naming' | 'components';
    rule: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: string[];
}

export interface InferredRules {
    generatedAt: string;
    rules: InferredRule[];
}

// Flatten TokenMap into a single array for easier analysis
function flattenTokens(tokenMap: TokenMap): Array<{ name: string; value: string; category: string }> {
    return Object.entries(tokenMap).flatMap(([category, tokens]) =>
        Object.values(tokens).map(t => ({ name: t.name, value: t.value, category }))
    )
}

export function inferRules(
    tokenMap: TokenMap,
    componentMap: ComponentMap
): InferredRules {
    const tokens = flattenTokens(tokenMap)
    const components = Object.values(componentMap)

    const rules: InferredRule[] = [
        ...inferSpacingRules(tokens),
        ...inferColorRules(tokens),
        ...inferBorderRadiusRules(tokens),
        ...inferTypographyRules(tokens),
        ...inferNamingRules(tokens),
        ...inferComponentRules(components),
    ];

    return {
        generatedAt: new Date().toISOString(),
        rules,
    };
}

// ─── Spacing ────────────────────────────────────────────────────────────────

function inferSpacingRules(tokens: Array<{ name: string; value: string; category: string }>): InferredRule[] {
    const rules: InferredRule[] = [];
    const spacingTokens = tokens.filter(t => t.category === 'spacing' && isNumericPx(t.value));

    if (spacingTokens.length < 2) return rules;

    const values = spacingTokens
        .map(t => parsePx(t.value))
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);

    // Check for 4px base scale
    const allMultiplesOf4 = values.every(v => v % 4 === 0);
    if (allMultiplesOf4) {
        rules.push({
            id: 'spacing-4px-base',
            category: 'spacing',
            rule: 'Spacing follows a 4px base scale. All spacing values are multiples of 4.',
            confidence: 'high',
            evidence: spacingTokens.map(t => `${t.name}: ${t.value}`),
        });
    } else {
        // Check for 8px base scale
        const allMultiplesOf8 = values.every(v => v % 8 === 0);
        if (allMultiplesOf8) {
            rules.push({
                id: 'spacing-8px-base',
                category: 'spacing',
                rule: 'Spacing follows an 8px base scale. All spacing values are multiples of 8.',
                confidence: 'high',
                evidence: spacingTokens.map(t => `${t.name}: ${t.value}`),
            });
        }
    }

    // Check for linear vs exponential scale
    if (values.length >= 3) {
        const diffs = values.slice(1).map((v, i) => v - values[i]);
        const isLinear = diffs.every(d => d === diffs[0]);
        if (isLinear) {
            rules.push({
                id: 'spacing-linear-scale',
                category: 'spacing',
                rule: `Spacing scale is linear with a step of ${diffs[0]}px.`,
                confidence: 'medium',
                evidence: values.map(v => `${v}px`),
            });
        }
    }

    return rules;
}

// ─── Color ───────────────────────────────────────────────────────────────────

function inferColorRules(tokens: Array<{ name: string; value: string; category: string }>): InferredRule[] {
    const rules: InferredRule[] = [];
    const colorTokens = tokens.filter(t => t.category === 'color' || t.category === 'colors');
    if (colorTokens.length === 0) return rules;

    // Check for semantic naming pattern (role-based vs descriptive)
    const semanticNames = ['primary', 'secondary', 'destructive', 'warning', 'success', 'muted', 'accent', 'background', 'foreground'];
    const descriptiveNames = ['red', 'blue', 'green', 'yellow', 'gray', 'white', 'black'];

    const semanticCount = colorTokens.filter(t =>
        semanticNames.some(s => t.name.toLowerCase().includes(s))
    ).length;

    const descriptiveCount = colorTokens.filter(t =>
        descriptiveNames.some(s => t.name.toLowerCase().includes(s))
    ).length;

    if (semanticCount > descriptiveCount) {
        rules.push({
            id: 'color-semantic-naming',
            category: 'color',
            rule: 'Colors are named semantically by role (primary, destructive, muted) rather than by value (red, blue). When adding colors, name them for their purpose, not their appearance.',
            confidence: 'high',
            evidence: colorTokens
                .filter(t => semanticNames.some(s => t.name.toLowerCase().includes(s)))
                .slice(0, 5)
                .map(t => t.name),
        });
    }

    // Check for hover/active variant pattern
    const baseColors = colorTokens.filter(t =>
        !t.name.includes('hover') && !t.name.includes('active') && !t.name.includes('focus')
    );
    const hoverColors = colorTokens.filter(t => t.name.includes('hover'));

    if (hoverColors.length > 0) {
        const ratio = hoverColors.length / baseColors.length;
        if (ratio > 0.3) {
            rules.push({
                id: 'color-interactive-variants',
                category: 'color',
                rule: 'Interactive colors have explicit hover/active/focus token variants. Do not hardcode state colors — use the corresponding variant token.',
                confidence: 'high',
                evidence: hoverColors.slice(0, 3).map(t => t.name),
            });
        }
    }

    // Check for dark mode pattern (if both light and dark tokens exist)
    const darkTokens = colorTokens.filter(t =>
        t.name.includes('dark') || t.name.includes('-dark-')
    );
    if (darkTokens.length > 2) {
        rules.push({
            id: 'color-dark-mode-tokens',
            category: 'color',
            rule: 'The codebase maintains explicit dark mode color tokens. Always pair light and dark variants when adding new color tokens.',
            confidence: 'medium',
            evidence: darkTokens.slice(0, 3).map(t => t.name),
        });
    }

    return rules;
}

// ─── Border radius ───────────────────────────────────────────────────────────

function inferBorderRadiusRules(tokens: Array<{ name: string; value: string; category: string }>): InferredRule[] {
    const rules: InferredRule[] = [];
    const radiusTokens = tokens.filter(t => t.category === 'border-radius' || t.category === 'borderRadius');
    if (radiusTokens.length === 0) return rules;

    // Check if there's a single dominant radius (uniform UI)
    const values = radiusTokens.map(t => t.value);
    const uniqueValues = [...new Set(values)];

    if (uniqueValues.length === 1) {
        rules.push({
            id: 'border-radius-uniform',
            category: 'border-radius',
            rule: `Border radius is uniform across all components: ${uniqueValues[0]}. Do not introduce custom border radius values.`,
            confidence: 'high',
            evidence: radiusTokens.map(t => `${t.name}: ${t.value}`),
        });
    } else {
        // Check for scale pattern
        const numericValues = values
            .map(v => parsePx(v))
            .filter((v): v is number => v !== null)
            .sort((a, b) => a - b);

        if (numericValues.length >= 3) {
            rules.push({
                id: 'border-radius-scale',
                category: 'border-radius',
                rule: `Border radius follows a defined scale with ${radiusTokens.length} steps. Use the nearest scale token rather than custom values.`,
                confidence: 'medium',
                evidence: radiusTokens.map(t => `${t.name}: ${t.value}`),
            });
        }
    }

    return rules;
}

// ─── Typography ──────────────────────────────────────────────────────────────

function inferTypographyRules(tokens: Array<{ name: string; value: string; category: string }>): InferredRule[] {
    const rules: InferredRule[] = [];
    const fontTokens = tokens.filter(t => t.category === 'typography');
    if (fontTokens.length === 0) return rules;

    const fontFamilyTokens = fontTokens.filter(t =>
        t.name.includes('font') && !t.name.includes('size') && !t.name.includes('weight')
    );

    if (fontFamilyTokens.length > 0) {
        const families = fontFamilyTokens.map(t => t.value);
        const monoFonts = fontFamilyTokens.filter(t =>
            t.name.includes('mono') || t.value.toLowerCase().includes('mono')
        );

        if (monoFonts.length > 0) {
            rules.push({
                id: 'typography-mono-for-code',
                category: 'typography',
                rule: 'A monospace font token exists for code and technical content. Use the mono font token for any code, technical strings, or data values.',
                confidence: 'high',
                evidence: monoFonts.map(t => `${t.name}: ${t.value}`),
            });
        }

        if (fontFamilyTokens.length === 1) {
            rules.push({
                id: 'typography-single-typeface',
                category: 'typography',
                rule: `A single typeface is used throughout: ${families[0]}. Do not introduce additional font families.`,
                confidence: 'high',
                evidence: fontFamilyTokens.map(t => `${t.name}: ${t.value}`),
            });
        }
    }

    return rules;
}

// ─── Naming conventions ──────────────────────────────────────────────────────

function inferNamingRules(tokens: Array<{ name: string; value: string; category: string }>): InferredRule[] {
    const rules: InferredRule[] = [];
    const allTokens = tokens;
    if (allTokens.length === 0) return rules;
    const names = allTokens.map(t => t.name);
    const kebabCount = names.filter(n => n.includes('-')).length;
    const camelCount = names.filter(n => /[a-z][A-Z]/.test(n)).length;
    const snakeCount = names.filter(n => n.includes('_')).length;

    const dominant = Math.max(kebabCount, camelCount, snakeCount);
    const total = names.length;

    if (kebabCount === dominant && kebabCount / total > 0.7) {
        rules.push({
            id: 'naming-kebab-case',
            category: 'naming',
            rule: 'Token names use kebab-case. New tokens must follow this convention.',
            confidence: 'high',
            evidence: names.slice(0, 4),
        });
    } else if (camelCount === dominant && camelCount / total > 0.7) {
        rules.push({
            id: 'naming-camel-case',
            category: 'naming',
            rule: 'Token names use camelCase. New tokens must follow this convention.',
            confidence: 'high',
            evidence: names.slice(0, 4),
        });
    }

    // Detect category prefix pattern
    const prefixedCount = allTokens.filter(t => {
        const prefix = t.name.split('-')[0];
        return ['color', 'spacing', 'font', 'radius', 'shadow', 'border'].includes(prefix);
    }).length;

    if (prefixedCount / total > 0.6) {
        rules.push({
            id: 'naming-category-prefix',
            category: 'naming',
            rule: 'Token names are prefixed with their category (color-, spacing-, font-, radius-). New tokens must follow this prefix convention.',
            confidence: 'high',
            evidence: allTokens
                .filter(t => ['color', 'spacing', 'font', 'radius'].includes(t.name.split('-')[0]))
                .slice(0, 4)
                .map(t => t.name),
        });
    }

    return rules;
}

// ─── Component patterns ──────────────────────────────────────────────────────

function inferComponentRules(components: Array<{ name: string; props?: Record<string, { type: string; required: boolean }> }>): InferredRule[] {
    const rules: InferredRule[] = [];
    if (components.length < 3) return rules;

    // Check for variant prop pattern
    const allProps = components.flatMap(c => Object.keys(c.props ?? {}));
    const variantCount = allProps.filter(p => p === 'variant').length;
    const sizeCount = allProps.filter(p => p === 'size').length;
    const disabledCount = allProps.filter(p => p === 'disabled').length;

    if (variantCount / components.length > 0.4) {
        rules.push({
            id: 'components-variant-prop',
            category: 'components',
            rule: `Components use a "variant" prop for visual variations. When building new components that need visual alternatives, use a "variant" prop rather than separate components.`,
            confidence: 'high',
            evidence: components
                .filter(c => c.props && 'variant' in c.props)
                .slice(0, 4)
                .map(c => c.name),
        });
    }

    if (sizeCount / components.length > 0.3) {
        rules.push({
            id: 'components-size-prop',
            category: 'components',
            rule: `Components use a "size" prop for sizing variations. Use size tokens as the allowed values rather than custom dimensions.`,
            confidence: 'medium',
            evidence: components
                .filter(c => c.props && 'size' in c.props)
                .slice(0, 4)
                .map(c => c.name),
        });
    }

    if (disabledCount / components.length > 0.5) {
        rules.push({
            id: 'components-disabled-prop',
            category: 'components',
            rule: 'Interactive components accept a "disabled" prop. Do not simulate disabled state with opacity or pointer-events alone — use the disabled prop.',
            confidence: 'high',
            evidence: components
                .filter(c => c.props && 'disabled' in c.props)
                .slice(0, 4)
                .map(c => c.name),
        });
    }

    return rules;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isNumericPx(value: string): boolean {
    return /^\d+(\.\d+)?px$/.test(value.trim());
}

function parsePx(value: string): number | null {
    const match = value.trim().match(/^(\d+(\.\d+)?)px$/);
    return match ? parseFloat(match[1]) : null;
}
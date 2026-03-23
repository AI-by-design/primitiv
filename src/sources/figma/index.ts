import { Source, FigmaSource, TokenMap, ComponentMap } from "../../types"

export class FigmaAdapter implements Source {
  constructor(private config: FigmaSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    throw new Error(
      "Figma adapter not yet implemented. Coming in a future release."
    )
  }
}

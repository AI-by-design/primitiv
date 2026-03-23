import { Source, StorybookSource, TokenMap, ComponentMap } from "../../types"

export class StorybookAdapter implements Source {
  constructor(private config: StorybookSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    throw new Error(
      "Storybook adapter not yet implemented. Coming in a future release."
    )
  }
}

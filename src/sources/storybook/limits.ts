/**
 * Resource limits for data received from a Storybook instance and its local
 * story files. Keep these values in one place so callers cannot accidentally
 * apply different limits to the same input.
 */
export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024
export const MAX_METADATA_STRING_BYTES = 1024
export const MAX_STORIES_PER_COMPONENT = 50

/** Explicit aliases for callers that prefer the input's longer name. */
export const MAX_MANIFEST_RESPONSE_BYTES = MAX_MANIFEST_BYTES
export const MAX_STORY_SOURCE_BYTES = MAX_SOURCE_BYTES

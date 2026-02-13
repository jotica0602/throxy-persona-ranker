/**
 * Gets the value of a field from a lead using different possible field names (e.g. CSV column variants).
 */
export function getFieldValue(lead: Record<string, string>, possibleFields: string[]): string {
  for (const field of possibleFields) {
    const value = lead[field] || lead[field.toLowerCase()] || lead[field.toUpperCase()]
    if (value && value.trim()) {
      return value
    }
  }
  return ''
}

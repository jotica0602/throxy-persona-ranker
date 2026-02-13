/**
 * Obtiene el nombre del campo según diferentes formatos de CSV
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

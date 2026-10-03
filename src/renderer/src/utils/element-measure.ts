/**
 * A callback ref that reports `read(element)` whenever the element it is
 * attached to mounts or changes size. Attaching through the ref (not an
 * effect over `ref.current`) keeps measuring an element that mounts after
 * the first render, such as the composer once an empty chat gets messages.
 */
export function createMeasureRef<T extends HTMLElement>(
  read: (element: T) => number,
  onMeasure: (value: number) => void
): (element: T | null) => void {
  let observer: ResizeObserver | null = null
  return (element) => {
    observer?.disconnect()
    observer = null
    if (!element) return
    const measure = (): void => onMeasure(read(element))
    measure()
    observer = new ResizeObserver(measure)
    observer.observe(element)
  }
}

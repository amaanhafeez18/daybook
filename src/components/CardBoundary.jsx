import { Component } from 'react'

// A card that fails (or whose chunk can't load offline) disappears instead of taking the page
// with it. Used by Today and Health for the lazily loaded cards.
export default class CardBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('Card crashed:', error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

export function CardSkeleton({ className = '' }) {
  return (
    <section className={`card td-food-skel ${className}`} aria-hidden="true">
      <span className="skeleton td-skel-title" />
      <span className="skeleton td-skel-pill" />
    </section>
  )
}

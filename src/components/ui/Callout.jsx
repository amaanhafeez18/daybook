import Icon from './Icon.jsx'

// The one info / warning / error / success box (styles: .callout in App.css). A tinted panel at
// the inset radius, a leading icon in the tone's colour, body text at the normal colour (errors
// stay readable), and optional actions under the text.
//   <Callout tone="danger" role="alert">{error}</Callout>
//   <Callout tone="warning" icon="cloudOff" actions={<Button size="sm">Try again</Button>}>…</Callout>
// tone: info (the accent) | warning | danger | success | neutral (a plain grey note).
// icon: an Icon name, false for none, or a node (a spinner, a food glyph).
const ICONS = { info: 'info', warning: 'alert', danger: 'alert', success: 'check', neutral: 'info' }

export default function Callout({ tone = 'info', icon, title, actions, as: Tag = 'div', className = '', children, ...props }) {
  const glyph = icon === false ? null
    : icon && typeof icon !== 'string' ? icon
      : <Icon name={icon || ICONS[tone] || 'info'} size={18} strokeWidth={tone === 'success' ? 2.4 : 2} />
  return (
    <Tag className={`callout is-${tone} ${className}`} {...props}>
      {glyph}
      <span className="callout-body">
        {title && <strong className="callout-title">{title}</strong>}
        {children && <span className="callout-text">{children}</span>}
        {actions && <span className="callout-actions">{actions}</span>}
      </span>
    </Tag>
  )
}

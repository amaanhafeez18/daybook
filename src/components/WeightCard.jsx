import WeighIn from './WeighIn.jsx'

// Health → Today's weight card: the shared weigh-in display (WeighIn.jsx). The number opens the
// weight chart (#/food/weight); "Weigh in" opens the Food page's weigh-in sheet; the weigh-in
// reminder (4–30 days since the last one) shows here with × to hide it for the day.
export default function WeightCard({ today, loaded = true }) {
  return <WeighIn today={today} loaded={loaded} to="food/weight" />
}

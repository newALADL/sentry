import {pick, isDate, isEqualWith} from 'lodash';
import {withRouter} from 'react-router';
import PropTypes from 'prop-types';
import React from 'react';
import moment from 'moment';

import {getFormattedDate} from 'app/utils/dates';
import {t} from 'app/locale';
import DataZoom from 'app/components/charts/components/dataZoom';
import LineChart from 'app/components/charts/lineChart';
import SentryTypes from 'app/sentryTypes';
import ToolBox from 'app/components/charts/components/toolBox';
import withApi from 'app/utils/withApi';

import EventsRequest from './utils/eventsRequest';
import EventsContext from './utils/eventsContext';

const DEFAULT_GET_CATEGORY = () => t('Events');

const dateComparator = (value, other) => {
  if (isDate(value) && isDate(other)) {
    return +value === +other;
  }

  // returning undefined will use default comparator
  return undefined;
};

const isEqualWithDates = (a, b) => isEqualWith(a, b, dateComparator);
const getDate = date =>
  date ? moment.utc(date).format(moment.HTML5_FMT.DATETIME_LOCAL_SECONDS) : null;

class EventsChart extends React.Component {
  static propTypes = {
    organization: SentryTypes.Organization,
    actions: PropTypes.object,
    period: PropTypes.string,
    start: PropTypes.instanceOf(Date),
    end: PropTypes.instanceOf(Date),
    utc: PropTypes.bool,

    // Callback for when chart has been zoomed
    onZoom: PropTypes.func,
  };

  constructor(props) {
    super(props);

    // Zoom history
    this.history = [];

    // Initialize current period instance state for zoom history
    this.saveCurrentPeriod(props);
  }

  // Need to be aggressive about not re-rendering because eCharts handles zoom so we
  // don't want the component to update (unless parameters besides time period were changed)
  shouldComponentUpdate(nextProps, nextState) {
    const periodKeys = ['period', 'start', 'end'];
    const nextPeriod = pick(nextProps, periodKeys);
    const currentPeriod = pick(this.props, periodKeys);

    // do not update if we are zooming or if period via props does not change
    if (nextProps.zoom || isEqualWithDates(currentPeriod, nextPeriod)) {
      return false;
    }

    return true;
  }

  componentDidUpdate() {
    // When component updates, make sure we sync current period state
    // for use in zoom history
    this.saveCurrentPeriod(this.props);
  }

  useHourlyInterval = () => {
    const {period, start, end} = this.props;

    if (typeof period === 'string') {
      return period.endsWith('h') || period === '1d';
    }

    return moment(end).diff(start, 'hours') <= 24;
  };

  /**
   * Save current period state from period in props to be used
   * in handling chart's zoom history state
   */
  saveCurrentPeriod = props => {
    this.currentPeriod = {
      period: props.period,
      start: getDate(props.start),
      end: getDate(props.end),
    };
  };

  /**
   * Sets the new period due to a zoom related action
   *
   * Saves the current period to an instance property so that we
   * can control URL state when zoom history is being manipulated
   * by the chart controls.
   *
   * Saves a callback function to be called after chart animation is completed
   */
  setPeriod = ({period, start, end}, saveHistory) => {
    const startFormatted = getDate(start);
    const endFormatted = getDate(end);

    // Save period so that we can revert back to it when using echarts "back" navigation
    if (saveHistory) {
      this.history.push(this.currentPeriod);
    }

    // Callback to let parent component know zoom has changed
    // This is required for some more perceived responsiveness since
    // we delay updating URL state so that chart animation can finish
    //
    // Parent container can use this to change into a loading state before
    // URL parameters are changed
    if (this.props.onZoom) {
      this.props.onZoom({
        period,
        start: startFormatted,
        end: endFormatted,
      });
    }

    this.zooming = () => {
      this.props.actions.updateParams({
        statsPeriod: period,
        start: startFormatted,
        end: endFormatted,
        zoom: '1',
      });

      this.saveCurrentPeriod({period, start, end});
    };
  };

  /**
   * Enable zoom immediately instead of having to toggle to zoom
   */
  handleChartReady = chart => {
    chart.dispatchAction({
      type: 'takeGlobalCursor',
      key: 'dataZoomSelect',
      dataZoomSelectActive: true,
    });
  };

  /**
   * Restores the chart to initial viewport/zoom level
   *
   * Updates URL state to reflect initial params
   */
  handleZoomRestore = (evt, chart) => {
    if (!this.history.length) {
      return;
    }

    this.setPeriod(this.history[0]);

    // reset history
    this.history = [];
  };

  handleDataZoom = (evt, chart) => {
    const model = chart.getModel();
    const {xAxis, series} = model.option;
    const axis = xAxis[0];
    const [firstSeries] = series;

    // if `rangeStart` and `rangeEnd` are null, then we are going back
    if (axis.rangeStart === null && axis.rangeEnd === null) {
      const previousPeriod = this.history.pop();

      if (!previousPeriod) {
        return;
      }

      this.setPeriod(previousPeriod);
    } else {
      // TODO: handle hourly intervals
      const start = moment.utc(firstSeries.data[axis.rangeStart][0]);

      // Add a day so we go until the end of the day (e.g. next day at midnight)
      const end = moment
        .utc(firstSeries.data[axis.rangeEnd][0])
        .add(1, this.useHourlyInterval() ? 'hour' : 'day')
        .subtract(1, 'second');

      this.setPeriod({period: null, start, end}, true);
    }
  };

  /**
   * Chart event when *any* rendering+animation finishes
   *
   * `this.zooming` acts as a callback function so that
   * we can let the native zoom animation on the chart complete
   * before we update URL state and re-render
   */
  handleChartFinished = () => {
    if (typeof this.zooming === 'function') {
      this.zooming();
      this.zooming = null;
    }
  };

  render() {
    const {period, utc, location} = this.props;

    let interval = '1d';
    let xAxisOptions = {};
    if (this.useHourlyInterval()) {
      interval = '1h';
      xAxisOptions.axisLabel = {
        formatter: value => getFormattedDate(value, 'LT', {local: !utc}),
      };
    }

    // TODO(billy): For now only include previous period when we use relative time

    return (
      <div>
        <EventsRequest
          {...this.props}
          interval={interval}
          showLoading
          query={(location.query && location.query.query) || ''}
          getCategory={DEFAULT_GET_CATEGORY}
          includePrevious={!!period}
        >
          {({timeseriesData, previousTimeseriesData}) => {
            return (
              <LineChart
                onChartReady={this.handleChartReady}
                isGroupedByDate
                useUtc={utc}
                interval={interval === '1h' ? 'hour' : 'day'}
                series={timeseriesData}
                seriesOptions={{
                  showSymbol: true,
                }}
                previousPeriod={previousTimeseriesData}
                grid={{
                  left: '18px',
                  right: '18px',
                }}
                xAxis={xAxisOptions}
                dataZoom={DataZoom()}
                toolBox={ToolBox(
                  {},
                  {
                    dataZoom: {
                      title: {
                        zoom: '',
                        back: '',
                      },
                    },
                    restore: {
                      title: ' ',
                    },
                  }
                )}
                onEvents={{
                  datazoom: this.handleDataZoom,
                  restore: this.handleZoomRestore,
                  finished: this.handleChartFinished,
                }}
              />
            );
          }}
        </EventsRequest>
      </div>
    );
  }
}

const EventsChartContainer = withRouter(
  withApi(
    class EventsChartWithParams extends React.Component {
      render() {
        return (
          <EventsContext.Consumer>
            {context => (
              <EventsChart
                {...context}
                project={context.project || []}
                environment={context.environment || []}
                {...this.props}
              />
            )}
          </EventsContext.Consumer>
        );
      }
    }
  )
);

export default EventsChartContainer;
export {EventsChart};
